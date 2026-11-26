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

test("review decisions resume a paused batch without a second resume call", { timeout: 10_000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "enrichment-review-resume-"));
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
  savePendingBatch(config.stateDir, {
    version: 1,
    jobId: "review-resume",
    requestId: "reviewed-batch",
    startRow: 1,
    endRow: 1,
    outputOffset: 0,
    rows: [{
      rowId: stableRowId(row, 1),
      source: row,
      rankedCandidates: rankedCandidateEmails(row, "email"),
      candidateEmail: row.email,
      verificationStatus: "not_processed",
      provenance: ["source-email"],
    }],
    providerChecksCount: 0,
    billableChecksCount: 0,
    billingUnknownCount: 0,
    cacheHitCount: 0,
  });
  saveJobState(config.stateDir, {
    id: "review-resume",
    status: "paused",
    pausedReason: VERIFIER_REVIEW_REQUIRED,
    inputPath,
    outputPath,
    provider: "builtin",
    checkpointRow: 0,
    processedRows: 0,
    totalRows: 0,
    providerChecksCount: 0,
    billableChecksCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith(config.verifierBaseUrl)) return originalFetch(input, init);
    if (url.endsWith("/review")) {
      if (init?.method === "POST") {
        return Response.json({
          requestId: "reviewed-batch",
          status: "queued",
          billingUnknownCount: 1,
        }, { status: 200 });
      }
      return Response.json({ error: "No review" }, { status: 409 });
    }
    if (init?.method === "POST") {
      return Response.json({
        requestId: "reviewed-batch",
        status: "queued",
      }, { status: 202 });
    }
    return Response.json({
      requestId: "reviewed-batch",
      status: "completed",
      provider: "builtin",
      results: [{
        email: row.email,
        status: "not_deep_verified",
        fromCache: false,
        billable: false,
      }],
      providerChecksCount: 0,
      billableChecksCount: 0,
      cacheHitCount: 0,
    });
  };

  const { app } = await import("../src/index");
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/jobs/review-resume`;
  const headers = { Authorization: "Bearer test-token" };
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const reviewResponse = await originalFetch(`${base}/review`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      token: "review-token",
      action: "skip",
      confirmDuplicateCharge: false,
    }),
  });
  assert.equal(reviewResponse.status, 200);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = loadJobStates(config.stateDir)[0];
    if (state?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(loadJobStates(config.stateDir)[0]?.status, "completed");
});
