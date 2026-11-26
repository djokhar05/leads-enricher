import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { config } from "../src/config";
import { runLeadJob } from "../src/job";
import { reconcileBatchAcknowledgements } from "../src/pending-batch";

const verifierDirectory = path.resolve(__dirname, "../../verifier");

test("real verifier retires checkpointed batches and acknowledged upload journals across restart", {
  skip: fs.existsSync(path.join(verifierDirectory, "src/index.ts"))
    ? false
    : "Requires the sibling verifier service",
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "enrichment-verifier-ack-"));
  const oldAuditDir = config.auditDir;
  config.auditDir = path.join(directory, "audit");
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const baseUrl = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  let childError = "";
  const stop = async (): Promise<void> => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const processToStop = child;
    const exit = new Promise<void>((resolve) => processToStop.once("exit", () => resolve()));
    processToStop.kill("SIGTERM");
    await exit;
  };
  t.after(async () => {
    await stop();
    config.auditDir = oldAuditDir;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const start = async (): Promise<void> => {
    child = spawn(process.execPath, [
      "--require", path.join(verifierDirectory, "node_modules/ts-node/register"),
      path.join(verifierDirectory, "src/index.ts"),
    ], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: "test",
        TS_NODE_PROJECT: path.join(verifierDirectory, "tsconfig.json"),
        PORT: String(port),
        VERIFIER_HOST: "127.0.0.1",
        VERIFIER_AUTH_TOKEN: "integration-token",
        VERIFIER_JOB_STORE_DIR: path.join(directory, "verifier"),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => { childError += chunk.toString(); });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Verifier exited: ${childError}`);
      try {
        if ((await fetch(`${baseUrl}/api/health`)).ok) return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error(`Verifier did not start: ${childError}`);
  };
  const verifierStore = path.join(directory, "verifier");
  fs.mkdirSync(path.join(verifierStore, "list-journals"), { recursive: true });
  const uploadJobId = "completed-upload";
  const journal = path.join(verifierStore, "list-journals", `${createHash("sha256").update(uploadJobId).digest("hex")}.jsonl`);
  fs.writeFileSync(journal, "private journal data\n");
  fs.writeFileSync(path.join(verifierStore, `${uploadJobId}.json`), JSON.stringify({
    version: 1, savedAt: Date.now(), job: {
      id: uploadJobId, userId: "user", listId: "list", manifestKey: "manifest",
      provider: "builtin", maxProviderCalls: 1, status: "completed", progress: 100,
      totalEmails: 1, validCount: 1, invalidCount: 0, uncertainCount: 0,
      catchAllCount: 0, duplicateCount: 0, providerFailedCount: 0, notDeepVerifiedCount: 0,
      providerChecksCount: 1, billableChecksCount: 1, cacheHitCount: 0,
      journalVersion: 1, creditReservationId: "reservation", resultKey: "upload-result",
    },
  }));
  await start();
  const uploadEndpoint = `${baseUrl}/api/jobs/${uploadJobId}/acknowledge-journal`;
  const uploadHeaders = { authorization: "Bearer integration-token", "content-type": "application/json" };
  const uploadAck = (reservationId: string) => fetch(uploadEndpoint, {
    method: "POST", headers: uploadHeaders,
    body: JSON.stringify({ reservationId, resultKey: "upload-result" }),
  });
  assert.equal((await uploadAck("wrong")).status, 409);
  assert.equal(fs.existsSync(journal), true);
  assert.equal((await uploadAck("reservation")).status, 204);
  assert.equal(fs.existsSync(journal), false);
  const inputPath = path.join(directory, "input.csv");
  fs.writeFileSync(inputPath, "email\nperson@example.test\n");
  const stateDir = path.join(directory, "jobs");
  const state = await runLeadJob({
    id: "integration", inputPath, outputPath: path.join(directory, "output.csv"), stateDir,
    provider: "builtin", providerCallLimit: 0, batchSize: 1,
    verifierBaseUrl: baseUrl, verifierAuthToken: "integration-token", emailColumn: "email",
  });
  assert.equal(state.status, "completed");
  assert.equal(state.providerChecksCount, 0);
  const outbox = path.join(stateDir, "batch-acknowledgements");
  const record = JSON.parse(fs.readFileSync(path.join(outbox, fs.readdirSync(outbox)[0]), "utf8")) as { requestId: string };
  const endpoint = `${baseUrl}/api/batches/${encodeURIComponent(record.requestId)}`;
  const headers = { authorization: "Bearer integration-token" };
  assert.equal((await fetch(endpoint, { headers })).status, 200);
  await reconcileBatchAcknowledgements(stateDir, baseUrl, "integration-token");
  assert.equal(fs.readdirSync(outbox).length, 0);
  assert.equal((await fetch(endpoint, { headers })).status, 410);
  const snapshot = path.join(directory, "verifier", "batches", `${createHash("sha256").update(record.requestId).digest("hex")}.json`);
  assert.doesNotMatch(fs.readFileSync(snapshot, "utf8"), /person@example\.test/);
  await stop();
  await start();
  assert.equal((await uploadAck("reservation")).status, 204);
  assert.equal((await fetch(endpoint, { headers })).status, 410);
  const retry = await fetch(`${baseUrl}/api/batches`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ requestId: record.requestId, provider: "builtin", emails: ["person@example.test"], maxProviderCalls: 0 }),
  });
  assert.equal(retry.status, 410);
});
