import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { config } from "../src/config";
import {
  resolveAllowedInputPath,
  resolveAllowedOutputPath,
} from "../src/security";

test("allowlisted input and output paths accept files inside configured directories", () => {
  const input = path.join(config.inputDir, "test.csv");
  const output = path.join(config.outputDir, "test.csv");
  assert.equal(resolveAllowedInputPath(input), path.resolve(input));
  assert.equal(resolveAllowedOutputPath(output), path.resolve(output));
});

test("allowlists reject path traversal outside configured directories", () => {
  const outside = path.resolve(config.inputDir, "..", "outside.csv");
  assert.throws(
    () => resolveAllowedInputPath(outside),
    /outside the allowed input directory/,
  );
});

test("disk and memory telemetry return finite resource values", async () => {
  const { diskUsage, memoryUsage } = await import("../src/resources");
  const disk = diskUsage(os.tmpdir());
  const memory = memoryUsage();
  assert.ok(disk.totalBytes >= 0);
  assert.ok(disk.freeBytes >= 0);
  assert.ok(memory.rssBytes > 0);
  assert.ok(memory.heapUsedBytes > 0);
});
