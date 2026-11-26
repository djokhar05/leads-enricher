import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { LeadRow } from "./types";

export interface PendingBatch {
  version: 1;
  jobId: string;
  requestId: string;
  startRow: number;
  endRow: number;
  outputOffset: number;
  rows: LeadRow[];
  tokenCount?: number;
  costEstimateUsd?: number;
  providerChecksCount?: number;
  billableChecksCount?: number;
  billingUnknownCount?: number;
  cacheHitCount?: number;
  verifierCompleted?: boolean;
}

const location = (directory: string, jobId: string): string => {
  const name = createHash("sha256").update(jobId).digest("hex");
  return path.join(directory, "pending-batches", `${name}.json`);
};

const syncDirectory = (directory: string): void => {
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};

export const loadPendingBatch = (directory: string, jobId: string): PendingBatch | undefined => {
  const filename = location(directory, jobId);
  if (!fs.existsSync(filename)) return undefined;
  const batch = JSON.parse(fs.readFileSync(filename, "utf8")) as PendingBatch;
  if (batch.version !== 1 || batch.jobId !== jobId || !batch.requestId ||
      !Number.isSafeInteger(batch.startRow) || !Number.isSafeInteger(batch.endRow) ||
      !Number.isSafeInteger(batch.outputOffset) || batch.outputOffset < 0 ||
      [batch.providerChecksCount, batch.billableChecksCount, batch.billingUnknownCount, batch.cacheHitCount]
        .some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0)) ||
      (batch.verifierCompleted !== undefined && typeof batch.verifierCompleted !== "boolean") ||
      !Array.isArray(batch.rows) || batch.rows.length !== batch.endRow - batch.startRow + 1) {
    throw new Error("Invalid saved enrichment batch; operator review required");
  }
  return batch;
};

export const savePendingBatch = (directory: string, batch: PendingBatch): void => {
  const filename = location(directory, batch.jobId);
  const folder = path.dirname(filename);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.chmodSync(folder, 0o700);
  syncDirectory(directory);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(batch));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filename);
  syncDirectory(folder);
};

export const deletePendingBatch = (directory: string, jobId: string): void => {
  const filename = location(directory, jobId);
  if (!fs.existsSync(filename)) return;
  fs.unlinkSync(filename);
  syncDirectory(path.dirname(filename));
};

export const completePendingBatch = (directory: string, batch: PendingBatch): void => {
  if (batch.verifierCompleted) {
    const folder = path.join(directory, "batch-acknowledgements");
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    fs.chmodSync(folder, 0o700);
    syncDirectory(directory);
    const name = createHash("sha256").update(batch.requestId).digest("hex");
    const filename = path.join(folder, `${name}.json`);
    if (!fs.existsSync(filename)) {
      const temporary = `${filename}.${randomUUID()}.tmp`;
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ requestId: batch.requestId, jobId: batch.jobId }));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, filename);
      syncDirectory(folder);
    }
  }
  deletePendingBatch(directory, batch.jobId);
};

export const reconcileBatchAcknowledgements = async (
  directory: string,
  baseUrl: string,
  authToken: string,
): Promise<void> => {
  const pendingFolder = path.join(directory, "pending-batches");
  if (fs.existsSync(pendingFolder)) {
    for (const name of fs.readdirSync(pendingFolder)) {
      if (!name.endsWith(".json")) continue;
      const saved: unknown = JSON.parse(fs.readFileSync(path.join(pendingFolder, name), "utf8"));
      if (typeof saved !== "object" || saved === null ||
          !("jobId" in saved) || typeof saved.jobId !== "string" ||
          !saved.jobId || name !== `${createHash("sha256").update(saved.jobId).digest("hex")}.json`) {
        throw new Error(`Invalid pending enrichment batch: ${name}`);
      }
      const statePath = path.resolve(directory, `${saved.jobId}.json`);
      if (path.dirname(statePath) !== path.resolve(directory)) {
        throw new Error(`Invalid pending enrichment job ID: ${name}`);
      }
      if (!fs.existsSync(statePath)) {
        console.error("[lead-enrichment] pending batch has no job snapshot", { jobId: saved.jobId });
        continue;
      }
      const state: unknown = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (typeof state !== "object" || state === null ||
          !("id" in state) || state.id !== saved.jobId ||
          !("checkpointRow" in state) || !Number.isSafeInteger(state.checkpointRow) ||
          Number(state.checkpointRow) < 0) {
        throw new Error(`Invalid enrichment job snapshot for pending batch: ${name}`);
      }
      const pending = loadPendingBatch(directory, saved.jobId);
      if (pending && Number(state.checkpointRow) >= pending.endRow) {
        completePendingBatch(directory, pending);
      }
    }
  }
  const folder = path.join(directory, "batch-acknowledgements");
  if (!fs.existsSync(folder)) return;
  for (const name of fs.readdirSync(folder)) {
    if (!name.endsWith(".json")) continue;
    const filename = path.join(folder, name);
    const record: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (typeof record !== "object" || record === null ||
        !("requestId" in record) || typeof record.requestId !== "string" ||
        !record.requestId || name !== `${createHash("sha256").update(record.requestId).digest("hex")}.json` ||
        !("jobId" in record) || typeof record.jobId !== "string" || !record.jobId) {
      throw new Error(`Invalid verifier acknowledgement record: ${name}`);
    }
    try {
      const response = await fetch(
        `${baseUrl.replace(/\/$/, "")}/api/batches/${encodeURIComponent(record.requestId)}/acknowledge`,
        {
          method: "POST",
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      fs.unlinkSync(filename);
      syncDirectory(folder);
    } catch (error) {
      console.error("[lead-enrichment] verifier batch acknowledgement failed", {
        jobId: record.jobId, requestId: record.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
};
