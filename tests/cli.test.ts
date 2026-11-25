import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getCliVersion, printCliHelp } from "../src/cli";

test("CLI help lists server mode and all job options", () => {
  const help = printCliHelp();
  assert.match(help, /--serve/);
  assert.match(help, /--input <path>/);
  assert.match(help, /--provider-call-limit <n>/);
  assert.match(help, /-h, --help/);
  assert.match(help, /-v, --version/);
});

test("CLI version comes from package metadata", () => {
  assert.equal(getCliVersion(), "1.0.0");
});

test("server mode starts when the service directory has a different name", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "enrichment-entry-test-"));
  const serviceRoot = path.resolve(__dirname, "..");
  const renamedRoot = path.join(directory, "leads-enricher");
  fs.symlinkSync(serviceRoot, renamedRoot, "dir");
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => error ? reject(error) : resolve()),
  );
  const child = spawn(process.execPath, [
    "--preserve-symlinks-main",
    "-r", path.join(serviceRoot, "node_modules/ts-node/register"),
    path.join(renamedRoot, "src/index.ts"),
    "--serve",
  ], {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PORT: String(port),
      TS_NODE_PROJECT: path.join(serviceRoot, "tsconfig.json"),
      LEAD_ENRICHMENT_AUTH_TOKEN: "test-token",
      VERIFIER_BASE_URL: "http://127.0.0.1:1",
    },
    stdio: "ignore",
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  let response: Response | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: "Bearer test-token" },
        signal: AbortSignal.timeout(500),
      });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.equal(response?.status, 200, "server did not start in the renamed directory");
});
