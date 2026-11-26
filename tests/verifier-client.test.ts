import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyBatch } from "../src/verifier-client";

test("asynchronous batches continue polling beyond 30 seconds without resubmitting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let submissions = 0;
  let polls = 0;
  t.mock.method(globalThis, "fetch", async (...[_input, init]: Parameters<typeof fetch>) => {
    if (init?.method === "POST") {
      submissions += 1;
      return new Response("{}", { status: 202 });
    }
    polls += 1;
    const finished = Date.now() >= 31_000;
    return new Response(JSON.stringify({
      requestId: "slow-batch",
      provider: "mailtester_ninja",
      status: finished ? "completed" : "processing",
      results: finished
        ? [{ email: "one@example.test", status: "valid", fromCache: false, billable: true }]
        : [],
      providerChecksCount: finished ? 1 : 0,
      billableChecksCount: finished ? 1 : 0,
      cacheHitCount: 0,
    }));
  });
  const resultPromise = verifyBatch(
    "http://localhost", "", "slow-batch", "mailtester_ninja", ["one@example.test"], 1,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (let second = 0; second < 32; second += 1) {
    t.mock.timers.tick(1_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.ok(Date.now() >= 31_000);
  assert.equal(submissions, 1);
  assert.ok(polls >= 31);
});
