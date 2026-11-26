import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "csv-parse/sync";
import { config } from "../src/config";
import { runLeadJob, VERIFIER_REVIEW_REQUIRED } from "../src/job";
import { enrichWithLlm } from "../src/provider-adapters";
import { rankedCandidateEmails, stableRowId } from "../src/csv";
import { loadPendingBatch, reconcileBatchAcknowledgements, savePendingBatch } from "../src/pending-batch";
import { saveJobState } from "../src/state";
import type { LeadJobState } from "../src/types";

const batchResponder = (
  makeResult: (request: { requestId: string; emails: string[]; provider: string }) => Record<string, unknown>,
) => {
  const results = new Map<string, Record<string, unknown>>();
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    if (init?.method === "POST") {
      const request = JSON.parse(String(init.body)) as { requestId: string; emails: string[]; provider: string };
      results.set(request.requestId, makeResult(request));
      return new Response(JSON.stringify({ requestId: request.requestId, status: "queued" }), { status: 202 });
    }
    const requestId = decodeURIComponent(new URL(String(input)).pathname.split("/").at(-1) || "");
    const result = results.get(requestId);
    if (!result) return new Response(null, { status: 404 });
    return new Response(JSON.stringify({ ...result, requestId, status: "completed" }));
  };
};

test("acknowledgements wait for durable checkpoints and survive a failed delivery", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lead-ack-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state: LeadJobState = {
    id: "ack-test", status: "processing", inputPath: "input", outputPath: "output",
    provider: "builtin", checkpointRow: 0, totalRows: 1, processedRows: 0,
    providerChecksCount: 1, billableChecksCount: 1, createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveJobState(directory, state);
  savePendingBatch(directory, {
    version: 1, jobId: state.id, requestId: "ack-request", startRow: 1, endRow: 1,
    outputOffset: 0,
    rows: [{ rowId: "row", source: {}, verificationStatus: "valid", provenance: [] }],
    verifierCompleted: true,
  });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    requests += 1;
    assert.equal(String(input), "http://verifier/api/batches/ack-request/acknowledge");
    assert.equal(init?.method, "POST");
    return new Response(null, { status: requests === 1 ? 503 : 204 });
  });
  await reconcileBatchAcknowledgements(directory, "http://verifier", "");
  assert.equal(requests, 0);
  assert.ok(loadPendingBatch(directory, state.id));
  saveJobState(directory, { ...state, checkpointRow: 1, processedRows: 1 });
  await reconcileBatchAcknowledgements(directory, "http://verifier", "");
  assert.equal(requests, 1);
  assert.equal(loadPendingBatch(directory, state.id), undefined);
  assert.equal(fs.readdirSync(path.join(directory, "batch-acknowledgements")).length, 1);
  await reconcileBatchAcknowledgements(directory, "http://verifier", "");
  assert.equal(requests, 2);
  assert.equal(fs.readdirSync(path.join(directory, "batch-acknowledgements")).length, 0);
});

test("new output omits verification metadata while preserving source values", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lead-job-test-"));
  const previousAuditDir = config.auditDir;
  config.auditDir = path.join(directory, "audit");
  t.after(() => {
    config.auditDir = previousAuditDir;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const inputPath = path.join(directory, "input.csv");
  const outputPath = path.join(directory, "output.csv");
  fs.writeFileSync(inputPath, "email,verification_from_cache\nperson@example.com,source value\n");

  t.mock.method(globalThis, "fetch", batchResponder(() => ({
      provider: "builtin",
      results: [{
        email: "person@example.com",
        status: "valid",
        reason: "accepted",
        domain: "example.com",
        fromCache: true,
        billable: false,
      }],
      providerChecksCount: 0,
      cacheHitCount: 1,
      billableChecksCount: 0,
    })));
  const state = await runLeadJob({
    id: "test",
    inputPath,
    outputPath,
    stateDir: path.join(directory, "jobs"),
    provider: "builtin",
    providerCallLimit: 10,
    batchSize: 10,
    verifierBaseUrl: "http://localhost",
    verifierAuthToken: "",
    emailColumn: "email",
  });
  assert.equal(state.status, "completed");
  assert.equal(state.cacheHitCount, 1);
  const rows: string[][] = parse(fs.readFileSync(outputPath), { relax_column_count: false });
  assert.deepEqual(rows[0], [
    "email", "verification_from_cache", "lead_row_id", "candidate_email",
    "verification_status", "verification_reason",
  ]);
  assert.equal(rows[1][1], "source value");
  assert.equal(rows[1][3], "person@example.com");
  assert.equal(rows[1][4], "valid");
  assert.match(rows[1][5], /^accepted/);
});

test("an uncertain verifier request is paused without retrying paid checks", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lead-job-test-"));
  const previousAuditDir = config.auditDir;
  config.auditDir = path.join(directory, "audit");
  t.after(() => {
    config.auditDir = previousAuditDir;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const inputPath = path.join(directory, "input.csv");
  fs.writeFileSync(inputPath, "email\nperson@example.com\n");
  let requests = 0;
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    controller.abort();
    throw new TypeError("fetch failed");
  });
  const state = await runLeadJob({
    id: "uncertain-verifier",
    inputPath,
    outputPath: path.join(directory, "output.csv"),
    stateDir: path.join(directory, "jobs"),
    provider: "mailtester_ninja",
    providerCallLimit: 10,
    batchSize: 10,
    verifierBaseUrl: "http://localhost",
    verifierAuthToken: "",
    emailColumn: "email",
    signal: controller.signal,
  });
  assert.equal(requests, 1);
  assert.equal(state.status, "paused");
  assert.equal(state.pausedReason, VERIFIER_REVIEW_REQUIRED);
  assert.match(state.error || "", /provider checks may still be running/);
  const saved = JSON.parse(fs.readFileSync(path.join(directory, "jobs", "uncertain-verifier.json"), "utf8")) as LeadJobState;
  assert.equal(saved.pausedReason, VERIFIER_REVIEW_REQUIRED);
});

test("a conflicting verifier request is paused without resubmitting", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lead-job-test-"));
  const previousAuditDir = config.auditDir;
  config.auditDir = path.join(directory, "audit");
  t.after(() => {
    config.auditDir = previousAuditDir;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const inputPath = path.join(directory, "input.csv");
  fs.writeFileSync(inputPath, "email\nperson@example.com\n");
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return new Response(null, { status: 409 });
  });
  const state = await runLeadJob({
    id: "conflicting-verifier",
    inputPath,
    outputPath: path.join(directory, "output.csv"),
    stateDir: path.join(directory, "jobs"),
    provider: "mailtester_ninja",
    providerCallLimit: 10,
    batchSize: 10,
    verifierBaseUrl: "http://localhost",
    verifierAuthToken: "",
    emailColumn: "email",
  });
  assert.equal(requests, 1);
  assert.equal(state.status, "paused");
  assert.equal(state.pausedReason, VERIFIER_REVIEW_REQUIRED);
  assert.match(state.error || "", /batch conflicting-verifier-.*HTTP 409/);
});

test("recovery reuses saved candidates and truncates uncommitted output", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lead-job-test-"));
  const previousAuditDir = config.auditDir;
  config.auditDir = path.join(directory, "audit");
  t.after(() => {
    config.auditDir = previousAuditDir;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const inputPath = path.join(directory, "input.csv");
  const outputPath = path.join(directory, "output.csv");
  const stateDir = path.join(directory, "jobs");
  fs.writeFileSync(inputPath, "email\nfirst@example.com\nsecond@example.com\n");
  const committed = "email,lead_row_id,candidate_email,verification_status,verification_reason\n" +
    "first@example.com,row-1,first@example.com,valid,accepted\n";
  fs.writeFileSync(outputPath, `${committed}second@example.com,partial`);
  const row = { email: "second@example.com" };
  const candidates = rankedCandidateEmails(row, "email");
  savePendingBatch(stateDir, {
    version: 1,
    jobId: "recovery",
    requestId: "recovery-stable-batch",
    startRow: 2,
    endRow: 2,
    outputOffset: Buffer.byteLength(committed),
    rows: [{
      rowId: stableRowId(row, 2), source: row,
      candidateEmail: candidates[0].email, rankedCandidates: candidates,
      verificationStatus: "not_processed", provenance: ["source-email"],
    }],
  });
  const submitted: string[] = [];
  t.mock.method(globalThis, "fetch", batchResponder((request) => {
    submitted.push(request.requestId);
    return {
      provider: "builtin",
      results: [{ email: row.email, status: "valid", fromCache: false, billable: true }],
      providerChecksCount: 1, cacheHitCount: 0, billableChecksCount: 1,
    };
  }));
  const initialState: LeadJobState = {
    id: "recovery", status: "processing", inputPath, outputPath, provider: "builtin",
    checkpointRow: 1, processedRows: 1, totalRows: 1, providerChecksCount: 0,
    billableChecksCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const result = await runLeadJob({
    id: "recovery", inputPath, outputPath, stateDir, provider: "builtin",
    providerCallLimit: 10, batchSize: 1, verifierBaseUrl: "http://localhost",
    verifierAuthToken: "", emailColumn: "email", initialState,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.currentStage, "completed");
  assert.equal(result.totalRows, 2);
  assert.ok(result.startedAt);
  assert.deepEqual(submitted, ["recovery-stable-batch"]);
  const rows: Array<Record<string, string>> = parse(fs.readFileSync(outputPath), { columns: true });
  assert.deepEqual(rows.map((entry) => entry.email), ["first@example.com", "second@example.com"]);
  assert.equal(rows[1].verification_status, "valid");
  assert.equal(loadPendingBatch(stateDir, "recovery"), undefined);
});

test("recovery fails rather than dropping a pending batch when input is truncated", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lead-job-test-"));
  const previousAuditDir = config.auditDir;
  config.auditDir = path.join(directory, "audit");
  t.after(() => {
    config.auditDir = previousAuditDir;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const inputPath = path.join(directory, "input.csv");
  const outputPath = path.join(directory, "output.csv");
  const stateDir = path.join(directory, "jobs");
  fs.writeFileSync(inputPath, "email\n");
  fs.writeFileSync(outputPath, "");
  const row = { email: "missing@example.com" };
  savePendingBatch(stateDir, {
    version: 1, jobId: "truncated", requestId: "truncated-batch",
    startRow: 1, endRow: 1, outputOffset: 0,
    rows: [{
      rowId: stableRowId(row, 1), source: row, verificationStatus: "not_processed",
      rankedCandidates: rankedCandidateEmails(row, "email"), provenance: ["source-email"],
    }],
  });
  const result = await runLeadJob({
    id: "truncated", inputPath, outputPath, stateDir, provider: "builtin",
    providerCallLimit: 10, batchSize: 1, verifierBaseUrl: "http://localhost",
    verifierAuthToken: "", emailColumn: "email",
  });
  assert.equal(result.status, "failed");
  assert.match(result.error || "", /Input ended before the saved enrichment batch/);
  assert.ok(loadPendingBatch(stateDir, "truncated"));
});

test("company names are not used as person names for candidate generation", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lead-job-test-"));
  const previous = {
    auditDir: config.auditDir,
    enabled: config.llmEnabled,
    provider: config.llmProvider,
    key: config.llmApiKey,
    baseUrl: config.llmBaseUrl,
  };
  config.auditDir = path.join(directory, "audit");
  config.llmEnabled = true;
  config.llmProvider = "gemini";
  config.llmApiKey = "test-key";
  config.llmBaseUrl = "http://ai.test";
  t.after(() => {
    config.auditDir = previous.auditDir;
    config.llmEnabled = previous.enabled;
    config.llmProvider = previous.provider;
    config.llmApiKey = previous.key;
    config.llmBaseUrl = previous.baseUrl;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const inputPath = path.join(directory, "input.csv");
  const outputPath = path.join(directory, "output.csv");
  fs.writeFileSync(inputPath,
    'company,website,owner,person,email\n' +
    '"Lassonde Studios",owner.test,"Lassonde Studios (Owner)",,\n' +
    '"Acme Studio",ai.test,,,\n' +
    '"River Works",person.test,"Jane Smith (Owner)",,\n' +
    '"North Works",other.test,,,\n' +
    '"West Works",mapped.test,,"WEST, Works (Owner)",\n' +
    '"East Works",existing.test,,"East Works",contact@existing.test\n',
  );
  const verifiedEmails: string[] = [];
  const verifier = batchResponder((request) => {
    verifiedEmails.push(...request.emails);
    return {
      provider: "builtin",
      results: request.emails.map((email) => ({
        email, status: "uncertain", reason: "unconfirmed", fromCache: false, billable: true,
      })),
      providerChecksCount: request.emails.length,
      billableChecksCount: request.emails.length,
      cacheHitCount: 0,
    };
  });
  t.mock.method(globalThis, "fetch", async (...[input, init]: Parameters<typeof fetch>) => {
    if (String(input).startsWith("http://ai.test")) {
      const request = JSON.parse(String(init?.body)) as {
        contents: Array<{ parts: Array<{ text: string }> }>;
      };
      const research = JSON.parse(request.contents[0].parts[0].text) as { domain: string };
      const names = research.domain === "ai.test"
        ? [{ firstName: "ACME", lastName: "Studio" }]
        : research.domain === "other.test"
          ? [{ firstName: "North", lastName: "Works" }, { firstName: "Alex", lastName: "Jones" }]
          : [];
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ names }) }] } }],
      }));
    }
    return verifier(input, init);
  });
  const state = await runLeadJob({
    id: "company-name",
    inputPath,
    outputPath,
    stateDir: path.join(directory, "jobs"),
    provider: "builtin",
    providerCallLimit: 100,
    batchSize: 10,
    verifierBaseUrl: "http://verifier.test",
    verifierAuthToken: "",
    companyNameColumn: "company",
    websiteColumn: "website",
    domainColumn: "website",
    ownerNameColumn: "owner",
    fullNameColumn: "person",
    emailColumn: "email",
    llmEnabled: true,
    websiteResearchEnabled: false,
    excludeMissingEmail: false,
  });
  assert.equal(state.status, "completed");
  const rows: Array<Record<string, string>> = parse(fs.readFileSync(outputPath), { columns: true });
  for (const index of [0, 1, 4]) {
    assert.equal(rows[index].candidate_email, "");
    assert.equal(rows[index].verification_status, "not_deep_verified");
  }
  assert.equal(rows[2].candidate_email, "jane.smith@person.test");
  assert.equal(rows[3].candidate_email, "alex.jones@other.test");
  assert.equal(rows[5].candidate_email, "contact@existing.test");
  assert.ok(verifiedEmails.includes("contact@existing.test"));
  assert.ok(verifiedEmails.includes("jane.smith@person.test"));
  assert.ok(verifiedEmails.includes("alex.jones@other.test"));
  assert.ok(verifiedEmails.every((email) =>
    !email.endsWith("@owner.test") &&
    !email.endsWith("@ai.test") &&
    !email.endsWith("@mapped.test") &&
    !email.startsWith("north.works@"),
  ));
});

test("resuming a legacy output keeps its existing columns aligned", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lead-job-test-"));
  const previousAuditDir = config.auditDir;
  config.auditDir = path.join(directory, "audit");
  t.after(() => {
    config.auditDir = previousAuditDir;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const inputPath = path.join(directory, "input.csv");
  const outputPath = path.join(directory, "output.csv");
  fs.writeFileSync(inputPath, "company\nFirst\nSecond\n");
  fs.writeFileSync(outputPath,
    "company,lead_row_id,candidate_email,verification_status,verification_reason,verification_domain,verification_from_cache,verification_provenance\n" +
    "First,old,,not_deep_verified,No candidate email could be generated,,false,source-row\n",
  );
  const initialState: LeadJobState = {
    id: "resume",
    status: "paused",
    inputPath,
    outputPath,
    provider: "builtin",
    checkpointRow: 1,
    totalRows: 1,
    processedRows: 1,
    providerChecksCount: 0,
    billableChecksCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const state = await runLeadJob({
    id: "resume",
    inputPath,
    outputPath,
    stateDir: path.join(directory, "jobs"),
    provider: "builtin",
    providerCallLimit: 10,
    batchSize: 10,
    verifierBaseUrl: "http://localhost",
    verifierAuthToken: "",
    initialState,
  });
  assert.equal(state.status, "completed");
  const rows: string[][] = parse(fs.readFileSync(outputPath), { relax_column_count: false });
  assert.equal(rows.length, 3);
  assert.equal(rows[2][0], "Second");
  assert.deepEqual(rows[2].slice(-3), ["", "false", "source-row"]);
});

test("the output filter excludes missing candidates by default and can retain them", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lead-job-test-"));
  const previousAuditDir = config.auditDir;
  config.auditDir = path.join(directory, "audit");
  t.after(() => {
    config.auditDir = previousAuditDir;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const inputPath = path.join(directory, "input.csv");
  const input = "name,email\nMissing,\nInvalid,bad@example.com\nUncertain,maybe@example.com\n";
  fs.writeFileSync(inputPath, input);
  t.mock.method(globalThis, "fetch", batchResponder(() => ({
      provider: "builtin",
      results: [
        { email: "bad@example.com", status: "invalid", fromCache: false, billable: true },
        { email: "maybe@example.com", status: "uncertain", fromCache: false, billable: true },
      ],
      providerChecksCount: 2,
      cacheHitCount: 0,
      billableChecksCount: 2,
    })));
  const options = {
    inputPath,
    stateDir: path.join(directory, "jobs"),
    provider: "builtin",
    providerCallLimit: 10,
    batchSize: 10,
    verifierBaseUrl: "http://localhost",
    verifierAuthToken: "",
    emailColumn: "email",
  };
  for (const excludeMissingEmail of [true, false]) {
    const outputPath = path.join(directory, `${excludeMissingEmail}.csv`);
    const state = await runLeadJob({
      ...options,
      id: String(excludeMissingEmail),
      outputPath,
      ...(excludeMissingEmail ? {} : { excludeMissingEmail: false }),
    });
    assert.equal(state.status, "completed");
    assert.equal(state.processedRows, 3);
    assert.equal(state.candidateMissingCount, 1);
    assert.equal(state.settings?.excludeMissingEmail, excludeMissingEmail);
    const rows: Array<Record<string, string>> = parse(fs.readFileSync(outputPath), { columns: true });
    assert.deepEqual(rows.map((row) => row.name),
      excludeMissingEmail ? ["Invalid", "Uncertain"] : ["Missing", "Invalid", "Uncertain"]);
    assert.equal(rows.find((row) => row.name === "Invalid")?.verification_status, "invalid");
    assert.equal(rows.find((row) => row.name === "Uncertain")?.verification_status, "uncertain");
    if (!excludeMissingEmail) {
      assert.equal(rows[0].verification_status, "not_deep_verified");
    }
  }
  assert.equal(fs.readFileSync(inputPath, "utf8"), input);
});

test("resuming restores the saved filter and mappings after an excluded row", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lead-job-test-"));
  const previousAuditDir = config.auditDir;
  config.auditDir = path.join(directory, "audit");
  t.after(() => {
    config.auditDir = previousAuditDir;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const inputPath = path.join(directory, "input.csv");
  const outputPath = path.join(directory, "output.csv");
  const stateDir = path.join(directory, "jobs");
  fs.writeFileSync(inputPath, "name,custom_address\nMissing,\nPresent,person@example.com\n");
  t.mock.method(globalThis, "fetch", batchResponder(() => ({
      provider: "builtin",
      results: [{ email: "person@example.com", status: "valid", fromCache: false, billable: true }],
      providerChecksCount: 1,
      cacheHitCount: 0,
      billableChecksCount: 1,
    })));
  const options = {
    id: "resume-filter",
    inputPath,
    outputPath,
    stateDir,
    provider: "builtin",
    providerCallLimit: 10,
    batchSize: 1,
    verifierBaseUrl: "http://localhost",
    verifierAuthToken: "",
  };
  const cancelled = await runLeadJob({
    ...options,
    emailColumn: "custom_address",
    cancelRequested: () => {
      const statePath = path.join(stateDir, "resume-filter.json");
      return fs.existsSync(statePath) &&
        (JSON.parse(fs.readFileSync(statePath, "utf8")) as LeadJobState).checkpointRow === 1;
    },
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.checkpointRow, 1);
  assert.equal(parse(fs.readFileSync(outputPath)).length, 1);
  const saved: LeadJobState = JSON.parse(fs.readFileSync(path.join(stateDir, "resume-filter.json"), "utf8"));
  const resumed = await runLeadJob({ ...options, initialState: saved });
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.settings?.emailColumn, "custom_address");
  assert.equal(resumed.settings?.excludeMissingEmail, true);
  const rows: Array<Record<string, string>> = parse(fs.readFileSync(outputPath), { columns: true });
  assert.deepEqual(rows.map((row) => row.name), ["Present"]);
  assert.equal(rows[0].verification_status, "valid");
});

test("cancellation interrupts website research before starting AI or verification", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lead-job-test-"));
  const previousAuditDir = config.auditDir;
  config.auditDir = path.join(directory, "audit");
  t.after(() => {
    config.auditDir = previousAuditDir;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const inputPath = path.join(directory, "input.csv");
  const outputPath = path.join(directory, "output.csv");
  fs.writeFileSync(inputPath, "website\nexample.com\nsecond.example.com\n");
  const controller = new AbortController();
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (...[, init]: Parameters<typeof fetch>) => {
    calls += 1;
    started();
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  });
  const job = runLeadJob({
    id: "cancel-research",
    inputPath,
    outputPath,
    stateDir: path.join(directory, "jobs"),
    provider: "builtin",
    providerCallLimit: 10,
    batchSize: 10,
    verifierBaseUrl: "http://localhost",
    verifierAuthToken: "",
    websiteColumn: "website",
    llmEnabled: true,
    signal: controller.signal,
  });
  await requestStarted;
  controller.abort();
  const state = await job;
  assert.equal(state.status, "cancelled");
  assert.equal(state.checkpointRow, 0);
  assert.equal(calls, 1);
  assert.equal(parse(fs.readFileSync(outputPath)).length, 1);
});

test("cancelling an AI request does not start the fallback provider", async (t) => {
  const previous = {
    enabled: config.llmEnabled,
    provider: config.llmProvider,
    key: config.llmApiKey,
    fallbackKey: config.llmFallbackApiKey,
  };
  config.llmEnabled = true;
  config.llmProvider = "gemini";
  config.llmApiKey = "test-key";
  config.llmFallbackApiKey = "test-fallback-key";
  t.after(() => {
    config.llmEnabled = previous.enabled;
    config.llmProvider = previous.provider;
    config.llmApiKey = previous.key;
    config.llmFallbackApiKey = previous.fallbackKey;
  });
  let calls = 0;
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  t.mock.method(globalThis, "fetch", async (...[, init]: Parameters<typeof fetch>) => {
    calls += 1;
    started();
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  });
  const controller = new AbortController();
  const request = enrichWithLlm({ domain: "example.com" }, controller.signal);
  await requestStarted;
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  assert.equal(calls, 1);
});

test("cancellation stops verification and preserves partial provider counts", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lead-job-test-"));
  const previousAuditDir = config.auditDir;
  config.auditDir = path.join(directory, "audit");
  t.after(() => {
    config.auditDir = previousAuditDir;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const inputPath = path.join(directory, "input.csv");
  const outputPath = path.join(directory, "output.csv");
  fs.writeFileSync(inputPath, "email\none@example.com\ntwo@example.com\n");
  const controller = new AbortController();
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  let batchId = "";
  let cancelId = "";
  let initialSubmission: string | undefined;
  t.mock.method(globalThis, "fetch", async (...[input, init]: Parameters<typeof fetch>) => {
    if (String(input).endsWith("/cancel")) {
      cancelId = decodeURIComponent(new URL(String(input)).pathname.split("/").at(-2) || "");
      return new Response("{}", { status: 200 });
    }
    if (init?.method === "POST") {
      if (initialSubmission) assert.equal(String(init.body), initialSubmission);
      else initialSubmission = String(init.body);
      const body = JSON.parse(String(init.body)) as { requestId: string };
      batchId = body.requestId;
      started();
      return new Response("{}", { status: 202 });
    }
    return new Response(JSON.stringify({
      requestId: batchId,
      provider: "builtin",
      status: "cancelled",
      results: [{ email: "one@example.com", status: "valid", fromCache: false, billable: true }],
      providerChecksCount: 1,
      billableChecksCount: 1,
      cacheHitCount: 0,
      cancelled: true,
    }), { status: 200 });
  });
  const job = runLeadJob({
    id: "cancel-verifier",
    inputPath,
    outputPath,
    stateDir: path.join(directory, "jobs"),
    provider: "builtin",
    providerCallLimit: 10,
    batchSize: 10,
    verifierBaseUrl: "http://localhost",
    verifierAuthToken: "",
    emailColumn: "email",
    signal: controller.signal,
  });
  await requestStarted;
  controller.abort();
  const state = await job;
  assert.equal(cancelId, batchId);
  assert.equal(state.status, "cancelled");
  assert.equal(state.checkpointRow, 0);
  assert.equal(state.providerChecksCount, 1);
  assert.equal(state.billableChecksCount, 1);
  assert.equal(parse(fs.readFileSync(outputPath)).length, 1);
  const resumed = await runLeadJob({
    id: "cancel-verifier",
    inputPath,
    outputPath,
    stateDir: path.join(directory, "jobs"),
    provider: "builtin",
    providerCallLimit: 10,
    batchSize: 10,
    verifierBaseUrl: "http://localhost",
    verifierAuthToken: "",
    emailColumn: "email",
    initialState: state,
  });
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.providerChecksCount, 1);
  assert.equal(resumed.billableChecksCount, 1);
  const rows: string[][] = parse(fs.readFileSync(outputPath));
  assert.equal(rows.length, 3);
  assert.equal(rows[1][3], "valid");
  assert.equal(rows[2][3], "not_deep_verified");
});
