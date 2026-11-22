import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "csv-parse";
import { rankedCandidateEmails } from "../src/csv";
import { memoryUsage } from "../src/resources";

const sizes = [300, 3_000, 30_000, 300_000, 1_000_000, 5_000_000];

const run = async (rows: number): Promise<void> => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "lead-enrichment-benchmark-"),
  );
  const input = path.join(directory, "benchmark.csv");
  const stream = fs.createWriteStream(input);
  stream.write("first_name,last_name,domain\n");
  for (let index = 0; index < rows; index += 1) {
    stream.write(`Person${index % 1000},Example${index % 100},example${index % 100}.com\n`);
  }
  await new Promise<void>((resolve, reject) => {
    stream.end(() => resolve());
    stream.once("error", reject);
  });

  const started = Date.now();
  let processed = 0;
  const parser = fs.createReadStream(input).pipe(
    parse({
      bom: true,
      columns: true,
      skip_empty_lines: true,
    }),
  );
  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    rankedCandidateEmails(
      record,
      undefined,
      "first_name",
      "last_name",
      "domain",
    );
    processed += 1;
  }
  const elapsedMs = Date.now() - started;
  const memory = memoryUsage();
  console.log(JSON.stringify({
    rows,
    processed,
    elapsedMs,
    rowsPerSecond: Math.round(processed / Math.max(elapsedMs / 1000, 0.001)),
    peakRssBytes: memory.rssBytes,
    heapUsedBytes: memory.heapUsedBytes,
  }));
  fs.rmSync(directory, { recursive: true, force: true });
};

void (async () => {
  for (const size of sizes) await run(size);
})();
