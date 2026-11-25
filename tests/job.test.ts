import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "csv-parse/sync";
import { config } from "../src/config";
import { runLeadJob } from "../src/job";
import { enrichWithLlm } from "../src/provider-adapters";
import type { LeadJobState } from "../src/types";

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

  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({
      requestId: "test",
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
    }), { status: 200 }),
  );
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
    const request = JSON.parse(String(init?.body)) as { emails: string[] };
    verifiedEmails.push(...request.emails);
    return new Response(JSON.stringify({
      requestId: "test",
      provider: "builtin",
      results: request.emails.map((email) => ({
        email, status: "uncertain", reason: "unconfirmed", fromCache: false, billable: true,
      })),
      providerChecksCount: request.emails.length,
      billableChecksCount: request.emails.length,
      cacheHitCount: 0,
    }));
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
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({
      requestId: "test",
      provider: "builtin",
      results: [
        { email: "bad@example.com", status: "invalid", fromCache: false, billable: true },
        { email: "maybe@example.com", status: "uncertain", fromCache: false, billable: true },
      ],
      providerChecksCount: 2,
      cacheHitCount: 0,
      billableChecksCount: 2,
    }), { status: 200 }),
  );
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
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({
      requestId: "resume-filter",
      provider: "builtin",
      results: [{ email: "person@example.com", status: "valid", fromCache: false, billable: true }],
      providerChecksCount: 1,
      cacheHitCount: 0,
      billableChecksCount: 1,
    }), { status: 200 }),
  );
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
  let finish!: (response: Response) => void;
  let batchId = "";
  let cancelId = "";
  t.mock.method(globalThis, "fetch", async (...[input, init]: Parameters<typeof fetch>) => {
    const body = JSON.parse(String(init?.body)) as { requestId: string; cancellable?: boolean };
    if (String(input).endsWith("/cancel")) {
      cancelId = body.requestId;
      finish(new Response(JSON.stringify({
        requestId: batchId,
        provider: "builtin",
        results: [{ email: "one@example.com", status: "valid", fromCache: false, billable: true }],
        providerChecksCount: 1,
        billableChecksCount: 1,
        cacheHitCount: 0,
        cancelled: true,
      }), { status: 200 }));
      return new Response("{}", { status: 200 });
    }
    batchId = body.requestId;
    assert.equal(body.cancellable, true);
    started();
    return await new Promise<Response>((resolve) => { finish = resolve; });
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
});
