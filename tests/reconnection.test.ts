import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { config } from "../src/config";
import { rankedCandidateEmails, stableRowId } from "../src/csv";
import { savePendingBatch } from "../src/pending-batch";
import { loadJobStates, saveJobState } from "../src/state";
import { VERIFIER_REVIEW_REQUIRED } from "../src/job";

test("reconnect only resumes a batch whose verifier status is safe", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "enrichment-reconnect-"));
  config.stateDir = path.join(directory, "jobs");
  config.inputDir = path.join(directory, "input");
  config.outputDir = path.join(directory, "output");
  config.auditDir = path.join(directory, "audit");
  config.authToken = "test-token";
  config.verifierBaseUrl = "http://verifier.test";
  fs.mkdirSync(config.stateDir);
  fs.mkdirSync(config.inputDir);
  fs.mkdirSync(config.outputDir);
  const inputPath = path.join(config.inputDir, "input.csv");
  const outputPath = path.join(config.outputDir, "output.csv");
  fs.writeFileSync(inputPath, "email\nperson@example.com\n");
  fs.writeFileSync(outputPath, "");
  const row = { email: "person@example.com" };
  const rankedCandidates = rankedCandidateEmails(row, "email");
  savePendingBatch(config.stateDir, {
    version: 1, jobId: "reconnect", requestId: "stable-batch",
    startRow: 1, endRow: 1, outputOffset: 0,
    rows: [{
      rowId: stableRowId(row, 1), source: row, rankedCandidates,
      candidateEmail: row.email, verificationStatus: "not_processed", provenance: ["source-email"],
    }],
    providerChecksCount: 0, billableChecksCount: 0, billingUnknownCount: 0, cacheHitCount: 0,
  });
  saveJobState(config.stateDir, {
    id: "reconnect", status: "paused", pausedReason: VERIFIER_REVIEW_REQUIRED,
    inputPath, outputPath, provider: "builtin", checkpointRow: 0,
    processedRows: 0, totalRows: 0, providerChecksCount: 0, billableChecksCount: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const originalFetch = globalThis.fetch;
  let verifierStatus = "paused";
  const submissions: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith(config.verifierBaseUrl)) return originalFetch(input, init);
    if (url.endsWith("/review")) return Response.json({ error: "No review" }, { status: 409 });
    if (init?.method === "POST") {
      submissions.push(JSON.parse(String(init.body)).requestId);
      return Response.json({ requestId: "stable-batch", status: verifierStatus }, { status: 202 });
    }
    return Response.json({
      requestId: "stable-batch", status: verifierStatus, provider: "builtin",
      results: [{ email: row.email, status: "valid", fromCache: false, billable: true }],
      providerChecksCount: 1, billableChecksCount: 1, cacheHitCount: 0,
    });
  };
  const { app } = await import("../src/index");
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/jobs/reconnect`;
  const headers = { Authorization: "Bearer test-token" };
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal((await originalFetch(`${base}/resume`, { method: "POST", headers })).status, 409);
  assert.deepEqual(submissions, []);
  verifierStatus = "completed";
  const review = await originalFetch(`${base}/review`, { headers });
  assert.deepEqual(await review.json(), { status: "reconnect" });
  assert.equal((await originalFetch(`${base}/resume`, { method: "POST", headers })).status, 202);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (loadJobStates(config.stateDir)[0]?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(loadJobStates(config.stateDir)[0]?.status, "completed");
  assert.deepEqual(submissions, ["stable-batch"]);
});
