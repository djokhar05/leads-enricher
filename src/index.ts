import express from "express";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import multer from "multer";
import {
  runLeadJob,
  VERIFIER_REVIEW_REQUIRED,
  VERIFIER_REVIEW_READY,
  type StartLeadJobOptions,
} from "./job";
import { ensureDir, loadJobStates, saveJobState } from "./state";
import { loadPendingBatch, reconcileBatchAcknowledgements } from "./pending-batch";
import type { LeadJobState } from "./types";
import { config } from "./config";
import { requireServiceAuth, resolveAllowedInputPath, resolveAllowedOutputPath } from "./security";
import { appendAudit, loadAuditEntries } from "./audit";
import { diskUsage, memoryUsage } from "./resources";
import { applyRetention, previewRetention } from "./retention";
import { getCliVersion, printCliHelp } from "./cli";
import { detectCsvHeaderMappings } from "./csv";
import { testLlmConnection } from "./provider-adapters";

// This entry point supports two modes: a local HTTP service or a one-shot CLI job.
export const app = express();
app.use(express.json({ limit: "2mb" }));

// All files and durable state stay on the enrichment host; nothing is uploaded to S3.
const stateDir = config.stateDir;
const inputDir = config.inputDir;
const outputDir = config.outputDir;
const verifierBaseUrl = config.verifierBaseUrl;
const verifierAuthToken = config.verifierAuthToken;
const port = config.port;

ensureDir(stateDir);
ensureDir(inputDir);
ensureDir(outputDir);
app.use(requireServiceAuth);

// Track only jobs currently running in this process. Durable job state is read from disk.
const running = new Map<string, Promise<LeadJobState>>();
const cancellationControllers = new Map<string, AbortController>();

const startTrackedJob = (options: StartLeadJobOptions): void => {
  const controller = new AbortController();
  cancellationControllers.set(options.id, controller);
  const promise = runLeadJob({ ...options, signal: controller.signal }).finally(() => {
    running.delete(options.id);
    cancellationControllers.delete(options.id);
  });
  running.set(options.id, promise);
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) =>
      callback(null, inputDir),
    filename: (_req, file, callback) =>
      callback(
        null,
        `${Date.now()}-${randomUUID()}-${path.basename(file.originalname)}`,
      ),
  }),
  limits: { fileSize: config.maxUploadBytes },
  fileFilter: (_req, file, callback) => {
    if (!file.originalname.toLowerCase().endsWith(".csv")) {
      callback(new Error("Only CSV uploads are accepted"));
      return;
    }
    callback(null, true);
  },
});

// Lightweight health endpoint for the admin proxy and service monitoring.
// Enrichment health includes a bounded verifier reachability check so operators
// can distinguish a local service failure from a downstream verifier outage.
app.get("/health", async (_req, res) => {
  let verifier:
    | {
        reachable: boolean;
        status?: string;
        queue?: { queued: number; active: number; total: number };
        providers?: Record<string, boolean>;
        error?: string;
      }
    | undefined;

  if (verifierBaseUrl) {
    try {
      const verifierResponse = await fetch(
        `${verifierBaseUrl.replace(/\/$/, "")}/api/health`,
        {
          headers: verifierAuthToken
            ? { Authorization: `Bearer ${verifierAuthToken}` }
            : {},
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (verifierResponse.ok) {
        const payload = await verifierResponse.json() as {
          status?: string;
          queue?: { queued: number; active: number; total: number };
          providers?: Record<string, boolean>;
        };
        verifier = {
          reachable: true,
          status: payload.status,
          queue: payload.queue,
          providers: payload.providers,
        };
      } else {
        verifier = {
          reachable: false,
          error: `Verifier returned HTTP ${verifierResponse.status}`,
        };
      }
    } catch (error) {
      verifier = {
        reachable: false,
        error:
          error instanceof Error
            ? error.message
            : "Verifier health request failed",
      };
    }
  }

  res.json({
    status: "ok",
    stateDir,
    inputDir,
    outputDir,
    activeJobs: running.size,
    maxConcurrentJobs: config.maxConcurrentJobs,
    memory: memoryUsage(),
    disk: diskUsage(outputDir),
    diskMinimumBytes: config.minFreeDiskBytes,
    auditEntries: loadAuditEntries(20),
    ai: {
      enabled: config.llmEnabled,
      provider: config.llmProvider,
      model: config.llmModel,
      fallbackProvider: config.llmFallbackProvider,
      fallbackModel: config.llmFallbackModel,
      websiteResearchEnabled: config.llmWebsiteResearchEnabled,
      primaryKeyConfigured: Boolean(config.llmApiKey),
      fallbackKeyConfigured: Boolean(config.llmFallbackApiKey),
    },
    verifier,
  });
});

app.post("/ai/test", async (_req, res) => {
  const result = await testLlmConnection();
  res.status(result.ok ? 200 : 503).json(result);
});

app.get("/jobs", (_req, res) => {
  res.json({ jobs: loadJobStates(stateDir) });
});

// Look up one persisted job and its latest checkpoint/progress.
app.get("/jobs/:jobId", (req, res) => {
  const jobId = String(req.params.jobId);
  const job = loadJobStates(stateDir).find((item) => item.id === jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(job);
});

app.get("/jobs/:jobId/output", (req, res) => {
  const jobId = String(req.params.jobId);
  const job = loadJobStates(stateDir).find((item) => item.id === jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (!fs.existsSync(job.outputPath)) {
    res.status(404).json({ error: "Output not found" });
    return;
  }
  res.download(job.outputPath);
});

app.post("/jobs", (req, res) => {
  console.info("[lead-enrichment] POST /jobs received", {
    provider: typeof req.body?.provider === "string"
      ? req.body.provider
      : "builtin",
    batchSize: Number(req.body?.batchSize) || config.batchSize,
  });
  // A new job receives explicit column mappings when the CSV does not contain
  // one of the standard email/name/domain fields.
  const body = req.body as {
    inputPath?: string;
    outputPath?: string;
    provider?: string;
    providerCallLimit?: number;
    batchSize?: number;
    emailColumn?: string;
    firstNameColumn?: string;
    lastNameColumn?: string;
    domainColumn?: string;
    companyNameColumn?: string;
    websiteColumn?: string;
    addressColumn?: string;
    ownerNameColumn?: string;
    fullNameColumn?: string;
    llmEnabled?: boolean;
    websiteResearchEnabled?: boolean;
    excludeMissingEmail?: boolean;
  };
  if (
    body.excludeMissingEmail !== undefined &&
    typeof body.excludeMissingEmail !== "boolean"
  ) {
    res.status(400).json({ error: "excludeMissingEmail must be a boolean" });
    return;
  }
  if (!body.inputPath) {
    res.status(400).json({ error: "inputPath is required" });
    return;
  }
  let inputPath: string;
  let outputPath: string;
  try {
    inputPath = resolveAllowedInputPath(body.inputPath);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid input path",
    });
    return;
  }
  if (!fs.existsSync(inputPath)) {
    res.status(404).json({ error: "Input CSV not found" });
    return;
  }
  if (running.size >= config.maxConcurrentJobs) {
    res.status(429).json({ error: "Maximum concurrent enrichment jobs reached" });
    return;
  }
  const disk = diskUsage(outputDir);
  if (
    !("unavailable" in disk) &&
    disk.freeBytes < config.minFreeDiskBytes
  ) {
    res.status(503).json({
      error: "Insufficient local disk space",
      freeBytes: disk.freeBytes,
      minimumFreeBytes: config.minFreeDiskBytes,
    });
    return;
  }

  const id = randomUUID();
  try {
    outputPath = body.outputPath
      ? resolveAllowedOutputPath(body.outputPath)
      : path.join(outputDir, `${id}.csv`);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid output path",
    });
    return;
  }
  const provider =
    typeof body.provider === "string" ? body.provider : "builtin";
  const providerCallLimit =
    Number.isInteger(body.providerCallLimit) &&
    Number(body.providerCallLimit) >= 0
      ? Number(body.providerCallLimit)
      : Number(process.env.LEAD_ENRICHMENT_PROVIDER_CALL_LIMIT) || 1000;
  const batchSize =
    Number.isInteger(body.batchSize) && Number(body.batchSize) > 0
      ? Number(body.batchSize)
      : Number(process.env.LEAD_ENRICHMENT_BATCH_SIZE) || 100;
  const settings = {
    providerCallLimit,
    batchSize,
    emailColumn: body.emailColumn,
    firstNameColumn: body.firstNameColumn,
    lastNameColumn: body.lastNameColumn,
    domainColumn: body.domainColumn,
    companyNameColumn: body.companyNameColumn,
    websiteColumn: body.websiteColumn,
    addressColumn: body.addressColumn,
    ownerNameColumn: body.ownerNameColumn,
    fullNameColumn: body.fullNameColumn,
    llmEnabled: typeof body.llmEnabled === "boolean" ? body.llmEnabled : config.llmEnabled,
    websiteResearchEnabled:
      typeof body.websiteResearchEnabled === "boolean"
        ? body.websiteResearchEnabled
        : config.llmWebsiteResearchEnabled,
    excludeMissingEmail: body.excludeMissingEmail ?? true,
  };

  const initial: LeadJobState = {
    id,
    status: "queued",
    inputPath,
    outputPath,
    provider,
    checkpointRow: 0,
    totalRows: 0,
    processedRows: 0,
    providerChecksCount: 0,
    billableChecksCount: 0,
    settings,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  // Save before processing so status and progress survive an API/process restart.
  saveJobState(stateDir, initial);
  console.info("[lead-enrichment] job queued", {
    jobId: id,
    provider,
    batchSize,
    excludeMissingEmail: settings.excludeMissingEmail,
  });
  appendAudit({
    timestamp: new Date().toISOString(),
    hostId: config.hostId,
    action: "lead_enrichment.job.created",
    jobId: id,
    status: "success",
    metadata: {
      provider,
      providerCallLimit,
      batchSize,
      excludeMissingEmail: settings.excludeMissingEmail,
    },
  });

  startTrackedJob({
    id,
    inputPath,
    outputPath,
    stateDir,
    provider,
    ...settings,
    verifierBaseUrl,
    verifierAuthToken,
    initialState: initial,
  });
  // Processing continues asynchronously after the job is accepted.
  res.status(202).json(initial);
});

app.get("/files", (_req, res) => {
  const listDirectory = (directory: string) =>
    fs.existsSync(directory)
      ? fs.readdirSync(directory)
          .map((name) => {
            const target = path.join(directory, name);
            const stat = fs.statSync(target);
            return {
              name,
              path: target,
              sizeBytes: stat.isFile() ? stat.size : 0,
              isFile: stat.isFile(),
              modifiedAt: stat.mtime.toISOString(),
            };
          })
          .filter((item) => item.isFile)
      : [];
  res.json({
    inputDir,
    outputDir,
    stateDir,
    inputs: listDirectory(inputDir),
    outputs: listDirectory(outputDir),
  });
});

app.delete("/files", (req, res) => {
  const requestedPath =
    typeof req.body?.path === "string" ? req.body.path : "";
  if (!requestedPath) {
    res.status(400).json({ error: "File path is required" });
    return;
  }

  let resolvedPath: string;
  try {
    const absolute = path.resolve(requestedPath);
    const relativeToInput = path.relative(path.resolve(inputDir), absolute);
    const relativeToOutput = path.relative(path.resolve(outputDir), absolute);
    const insideInput =
      relativeToInput === "" ||
      (!relativeToInput.startsWith("..") && !path.isAbsolute(relativeToInput));
    const insideOutput =
      relativeToOutput === "" ||
      (!relativeToOutput.startsWith("..") && !path.isAbsolute(relativeToOutput));
    if (!insideInput && !insideOutput) {
      res.status(400).json({
        error: "File is outside the configured input/output directories",
      });
      return;
    }
    resolvedPath = absolute;
  } catch {
    res.status(400).json({ error: "Invalid file path" });
    return;
  }

  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  const activeJobs = loadJobStates(stateDir).filter((job) =>
    ["queued", "processing", "paused"].includes(job.status),
  );
  const referencedByActiveJob = activeJobs.some(
    (job) =>
      path.resolve(job.inputPath) === resolvedPath ||
      path.resolve(job.outputPath) === resolvedPath,
  );
  if (referencedByActiveJob) {
    res.status(409).json({
      error: "File belongs to an active enrichment job",
    });
    return;
  }

  fs.unlinkSync(resolvedPath);
  for (const job of loadJobStates(stateDir)) {
    let changed = false;
    const update: typeof job = { ...job };
    if (path.resolve(job.inputPath) === resolvedPath) {
      update.inputDeleted = true;
      changed = true;
    }
    if (path.resolve(job.outputPath) === resolvedPath) {
      update.outputDeleted = true;
      changed = true;
    }
    if (changed) saveJobState(stateDir, update);
  }
  appendAudit({
    timestamp: new Date().toISOString(),
    hostId: config.hostId,
    action: "lead_enrichment.file.deleted",
    status: "success",
    metadata: { path: resolvedPath },
  });
  res.json({ deleted: true, path: resolvedPath });
});

app.get("/jobs/:jobId/review", async (req, res) => {
  const jobId = String(req.params.jobId);
  const job = loadJobStates(stateDir).find((state) => state.id === jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  const pending = loadPendingBatch(stateDir, jobId);
  if (job.pausedReason !== VERIFIER_REVIEW_REQUIRED || !pending) {
    res.status(409).json({ error: "This job has no recoverable batch awaiting review" });
    return;
  }
  try {
    const response = await fetch(
      `${verifierBaseUrl.replace(/\/$/, "")}/api/batches/${encodeURIComponent(pending.requestId)}/review`,
      {
        headers: verifierAuthToken ? { Authorization: `Bearer ${verifierAuthToken}` } : {},
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.status === 409) {
      const statusResponse = await fetch(
        `${verifierBaseUrl.replace(/\/$/, "")}/api/batches/${encodeURIComponent(pending.requestId)}`,
        {
          headers: verifierAuthToken ? { Authorization: `Bearer ${verifierAuthToken}` } : {},
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (statusResponse.ok) {
        const status: unknown = await statusResponse.json();
        if (typeof status === "object" && status !== null &&
            "requestId" in status && status.requestId === pending.requestId &&
            "status" in status && typeof status.status === "string" &&
            ["queued", "processing", "completed", "cancelled"].includes(status.status)) {
          res.json({ status: "reconnect" });
          return;
        }
      }
    }
    res.status(response.status).json(await response.json());
  } catch (error) {
    console.error("[lead-enrichment] unable to load batch review", {
      jobId, error: error instanceof Error ? error.message : String(error),
    });
    res.status(502).json({ error: "Unable to load verifier batch review" });
  }
});

app.post("/jobs/:jobId/review", async (req, res) => {
  const jobId = String(req.params.jobId);
  const job = loadJobStates(stateDir).find((state) => state.id === jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (running.has(jobId) || job.pausedReason !== VERIFIER_REVIEW_REQUIRED) {
    res.status(409).json({ error: "Job is not waiting for a verifier review" });
    return;
  }
  const pending = loadPendingBatch(stateDir, jobId);
  const token: unknown = req.body?.token;
  const action: unknown = req.body?.action;
  if (!pending || typeof token !== "string" || !token || !["skip", "retry"].includes(String(action)) ||
      (action === "retry" && req.body?.confirmDuplicateCharge !== true)) {
    res.status(400).json({ error: "A pending batch, review token and action are required; retry also requires duplicate-charge confirmation" });
    return;
  }
  try {
    const response = await fetch(
      `${verifierBaseUrl.replace(/\/$/, "")}/api/batches/${encodeURIComponent(pending.requestId)}/review`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(verifierAuthToken ? { Authorization: `Bearer ${verifierAuthToken}` } : {}),
        },
        body: JSON.stringify({ token, action, confirmDuplicateCharge: req.body?.confirmDuplicateCharge }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const payload: unknown = await response.json();
    if (!response.ok) {
      console.warn("[lead-enrichment] verifier rejected batch review", {
        jobId, requestId: pending.requestId, httpStatus: response.status,
      });
      res.status(response.status).json(payload);
      return;
    }
    if (typeof payload !== "object" || payload === null || !("status" in payload) ||
        typeof payload.status !== "string") {
      res.status(502).json({ error: "Verifier returned an invalid review response" });
      return;
    }
    if (["queued", "processing", "completed", "cancelled"].includes(payload.status)) {
      const resumed = saveJobState(stateDir, {
        ...job,
        status: "queued",
        cancelRequested: false,
        pausedReason: undefined,
        pausedAt: undefined,
        error: undefined,
      });
      appendAudit({
        timestamp: new Date().toISOString(),
        hostId: config.hostId,
        action: "lead_enrichment.job.resumed",
        jobId,
        status: "success",
        metadata: { after: "batch_review" },
      });
      startTrackedJob({
        id: resumed.id,
        inputPath: resumed.inputPath,
        outputPath: resumed.outputPath,
        stateDir,
        provider: resumed.provider,
        providerCallLimit: resumed.settings?.providerCallLimit ?? config.providerCallLimit,
        batchSize: resumed.settings?.batchSize ?? config.batchSize,
        verifierBaseUrl,
        verifierAuthToken,
        initialState: resumed,
        llmEnabled: resumed.settings?.llmEnabled ?? config.llmEnabled,
        websiteResearchEnabled: resumed.settings?.websiteResearchEnabled ?? config.llmWebsiteResearchEnabled,
      });
    }
    appendAudit({
      timestamp: new Date().toISOString(),
      hostId: config.hostId,
      action: "lead_enrichment.batch.reviewed",
      jobId,
      status: "success",
      metadata: { decision: action },
    });
    res.json(payload);
  } catch (error) {
    console.error("[lead-enrichment] unable to submit batch review", {
      jobId, error: error instanceof Error ? error.message : String(error),
    });
    res.status(502).json({ error: "Unable to submit verifier batch review; retry the same decision" });
  }
});

app.post("/jobs/:jobId/resume", async (req, res) => {
  const jobId = String(req.params.jobId);
  const existing = loadJobStates(stateDir).find((job) => job.id === jobId);
  if (!existing) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (running.has(jobId)) {
    res.status(409).json({ error: "Job is already running" });
    return;
  }
  if (!["paused", "failed", "cancelled"].includes(existing.status)) {
    res.status(409).json({ error: "Only paused, failed, or cancelled jobs can resume" });
    return;
  }
  if (loadPendingBatch(stateDir, jobId)) {
    const pending = loadPendingBatch(stateDir, jobId);
    if (!pending) {
      res.status(409).json({ error: "The pending verifier batch is missing; operator review is required" });
      return;
    }
    try {
      const response = await fetch(
        `${verifierBaseUrl.replace(/\/$/, "")}/api/batches/${encodeURIComponent(pending.requestId)}`,
        {
          headers: verifierAuthToken ? { Authorization: `Bearer ${verifierAuthToken}` } : {},
          signal: AbortSignal.timeout(10_000),
        },
      );
      const batch: unknown = await response.json();
      if (!response.ok || typeof batch !== "object" || batch === null ||
          !("requestId" in batch) || batch.requestId !== pending.requestId ||
          !("status" in batch) || typeof batch.status !== "string" ||
          !["queued", "processing", "completed", "cancelled"].includes(batch.status)) {
        console.warn("[lead-enrichment] verifier batch cannot be reconnected", {
          jobId, requestId: pending.requestId, httpStatus: response.status,
        });
        res.status(409).json({ error: "Verifier outcome requires operator review; resume could duplicate paid checks" });
        return;
      }
    } catch (error) {
      console.error("[lead-enrichment] unable to reconnect verifier batch", {
        jobId, requestId: pending.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({ error: "Unable to reconnect to the verifier batch" });
      return;
    }
  }
  const latest = loadJobStates(stateDir).find((job) => job.id === jobId);
  if (running.has(jobId) || !latest || latest.updatedAt !== existing.updatedAt) {
    res.status(409).json({ error: "Job changed while the verifier was being checked; refresh and try again" });
    return;
  }
  const resumed = saveJobState(stateDir, {
    ...existing,
    status: "queued",
    cancelRequested: false,
    pausedReason: undefined,
    pausedAt: undefined,
    error: undefined,
  });
  appendAudit({
    timestamp: new Date().toISOString(),
    hostId: config.hostId,
    action: "lead_enrichment.job.resumed",
    jobId,
    status: "success",
  });

  startTrackedJob({
    id: resumed.id,
    inputPath: resumed.inputPath,
    outputPath: resumed.outputPath,
    stateDir,
    provider: resumed.provider,
    providerCallLimit: config.providerCallLimit,
    batchSize: config.batchSize,
    verifierBaseUrl,
    verifierAuthToken,
    initialState: resumed,
    llmEnabled: config.llmEnabled,
    websiteResearchEnabled: config.llmWebsiteResearchEnabled,
  });
  res.status(202).json(resumed);
});

app.post("/jobs/:jobId/cancel", (req, res) => {
  const jobId = String(req.params.jobId);
  const existing = loadJobStates(stateDir).find((job) => job.id === jobId);
  if (!existing) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (["completed", "failed", "cancelled"].includes(existing.status)) {
    res.status(409).json({ error: "Job is already terminal" });
    return;
  }
  if (existing.cancelRequested && running.has(jobId)) {
    res.json(existing);
    return;
  }
  const cancelled = saveJobState(stateDir, {
    ...existing,
    cancelRequested: true,
    ...(!running.has(jobId) ? {
      status: "cancelled" as const,
      error: "Cancelled by operator",
    } : {}),
  });
  cancellationControllers.get(jobId)?.abort();
  appendAudit({
    timestamp: new Date().toISOString(),
    hostId: config.hostId,
    action: "lead_enrichment.job.cancel_requested",
    jobId,
    status: "success",
  });
  res.json(cancelled);
});

app.post("/jobs/:jobId/retry", (req, res) => {
  const jobId = String(req.params.jobId);
  const existing = loadJobStates(stateDir).find((job) => job.id === jobId);
  if (!existing) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (!["failed", "paused"].includes(existing.status)) {
    res.status(409).json({ error: "Only failed or paused jobs can retry" });
    return;
  }
  if (existing.pausedReason === VERIFIER_REVIEW_REQUIRED) {
    res.status(409).json({ error: "Verifier outcome requires operator review; automatic retry could duplicate paid checks" });
    return;
  }
  if ((existing.retryCount || 0) >= config.maxRetryAttempts) {
    res.status(429).json({ error: "Maximum retry attempts reached" });
    return;
  }
  const retried = saveJobState(stateDir, {
    ...existing,
    status: "queued",
    retryCount: (existing.retryCount || 0) + 1,
    cancelRequested: false,
    error: undefined,
  });
  appendAudit({
    timestamp: new Date().toISOString(),
    hostId: config.hostId,
    action: "lead_enrichment.job.retry",
    jobId,
    status: "success",
  });
  startTrackedJob({
    id: retried.id,
    inputPath: retried.inputPath,
    outputPath: retried.outputPath,
    stateDir,
    provider: retried.provider,
    providerCallLimit: config.providerCallLimit,
    batchSize: config.batchSize,
    verifierBaseUrl,
    verifierAuthToken,
    initialState: retried,
    llmEnabled: config.llmEnabled,
    websiteResearchEnabled: config.llmWebsiteResearchEnabled,
  });
  res.status(202).json(retried);
});

app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "CSV file is required" });
    return;
  }
  console.info("[lead-enrichment] POST /upload received", {
    fileName: req.file.filename,
    sizeBytes: req.file.size,
  });
  let mappings: ReturnType<typeof detectCsvHeaderMappings> | null = null;
  try {
    const stream = fs.createReadStream(req.file.path);
    const { parse } = await import("csv-parse");
    const parser = stream.pipe(
      parse({
        bom: true,
        columns: false,
        relax_column_count: true,
        skip_empty_lines: true,
        to_line: 1,
      }),
    );
    for await (const record of parser as AsyncIterable<unknown>) {
      if (Array.isArray(record)) {
        mappings = detectCsvHeaderMappings(
          record.map((value) => String(value || "")),
        );
      }
      break;
    }
  } catch {
    mappings = null;
  }
  appendAudit({
    timestamp: new Date().toISOString(),
    hostId: config.hostId,
    action: "lead_enrichment.file.uploaded",
    status: "success",
    metadata: {
      fileName: req.file.filename,
      sizeBytes: req.file.size,
    },
  });
  res.status(201).json({
    fileName: req.file.filename,
    inputPath: req.file.path,
    mappings,
  });
});

app.get("/resources", (_req, res) => {
  res.json({
    memory: memoryUsage(),
    disk: diskUsage(outputDir),
    activeJobs: running.size,
    maxConcurrentJobs: config.maxConcurrentJobs,
  });
});

app.get("/audit", (req, res) => {
  const requested = Number(req.query.limit);
  res.json({
    entries: loadAuditEntries(
      Number.isInteger(requested) && requested > 0
        ? Math.min(requested, 500)
        : 200,
    ),
  });
});

app.get("/retention/preview", (_req, res) => {
  res.json(previewRetention());
});

app.post("/retention/apply", (_req, res) => {
  const preview = applyRetention();
  appendAudit({
    timestamp: new Date().toISOString(),
    hostId: config.hostId,
    action: "lead_enrichment.retention.applied",
    status: "success",
    metadata: {
      jobCount: preview.jobs.length,
      fileCount: preview.files.length,
    },
  });
  res.json(preview);
});

// Only start a server or CLI job when this module is the entry point.
const isCli = require.main === module;

// CLI information flags take precedence over server and job modes.
if (
  isCli &&
  process.argv.some((argument) => argument === "-h" || argument === "--help")
) {
  console.log(printCliHelp());
  process.exitCode = 0;
} else if (
  isCli &&
  process.argv.some((argument) => argument === "-v" || argument === "--version")
) {
  console.log(getCliVersion());
  process.exitCode = 0;
// API server mode is explicitly selected to avoid starting a port for every CLI invocation.
} else if (isCli && process.argv.includes("--serve")) {
  let acknowledging = false;
  const acknowledgeBatches = (): void => {
    if (acknowledging) return;
    acknowledging = true;
    void reconcileBatchAcknowledgements(stateDir, verifierBaseUrl, verifierAuthToken)
      .catch((error: unknown) => console.error("[lead-enrichment] batch acknowledgement recovery failed", {
        error: error instanceof Error ? error.message : String(error),
      }))
      .finally(() => { acknowledging = false; });
  };
  acknowledgeBatches();
  const acknowledgementTimer = setInterval(acknowledgeBatches, 60_000);
  acknowledgementTimer.unref();
  for (const state of loadJobStates(stateDir)) {
    if (
      state.cancelRequested &&
      ["queued", "processing", "paused"].includes(state.status)
    ) {
      if (loadPendingBatch(stateDir, state.id)) {
        saveJobState(stateDir, {
          ...state,
          status: "paused",
          pausedReason: VERIFIER_REVIEW_REQUIRED,
          pausedAt: new Date().toISOString(),
          error: "Cancellation was interrupted; the verifier batch and its billing require operator review",
        });
        continue;
      }
      saveJobState(stateDir, {
        ...state,
        status: "cancelled",
        error: "Cancelled by operator",
      });
      continue;
    }
    if (
      ["queued", "processing", "paused"].includes(state.status) &&
      !state.cancelRequested &&
      state.pausedReason !== VERIFIER_REVIEW_REQUIRED
    ) {
      if (running.size >= config.maxConcurrentJobs) break;
      const resumed = saveJobState(stateDir, {
        ...state,
        status: "queued",
        pausedReason: undefined,
        pausedAt: undefined,
      });
      appendAudit({
        timestamp: new Date().toISOString(),
        hostId: config.hostId,
        action: "lead_enrichment.job.auto_resumed",
        jobId: resumed.id,
        status: "success",
      });
      startTrackedJob({
        id: resumed.id,
        inputPath: resumed.inputPath,
        outputPath: resumed.outputPath,
        stateDir,
        provider: resumed.provider,
        providerCallLimit: config.providerCallLimit,
        batchSize: config.batchSize,
        verifierBaseUrl,
        verifierAuthToken,
        initialState: resumed,
        llmEnabled: config.llmEnabled,
        websiteResearchEnabled: config.llmWebsiteResearchEnabled,
      });
    }
  }
  const server = app.listen(port, () => {
    console.log(`Lead enrichment service listening on port ${port}`);
  });
  server.on("error", (error) => {
    if (
      error &&
      "code" in error &&
      error.code === "EADDRINUSE"
    ) {
      void fetch(`http://127.0.0.1:${port}/health`, {
        headers: config.authToken
          ? { Authorization: `Bearer ${config.authToken}` }
          : {},
        signal: AbortSignal.timeout(3_000),
      }).then((response) => {
        if (response.ok) {
          console.info(
            `[lead-enrichment] port ${port} already has a healthy enrichment service; reusing existing process`,
          );
          process.exitCode = 0;
          return;
        }
        console.error("[lead-enrichment] HTTP server failed to start", {
          port,
          error: "address already in use",
        });
        process.exitCode = 1;
      }).catch(() => {
        console.error("[lead-enrichment] HTTP server failed to start", {
          port,
          error: "address already in use",
        });
        process.exitCode = 1;
      });
      return;
    }
    console.error("[lead-enrichment] HTTP server failed to start", {
      port,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
} else if (isCli) {
  // Minimal argument parser for one-shot local CSV processing.
  const argument = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const inputPath = argument("--input");
  if (!inputPath) {
    console.error("Usage: lead-enrichment --input <csv> [--output <csv>] [--provider builtin]");
    process.exitCode = 1;
  } else {
    const id = randomUUID();
    let resolvedInput = "";
    let resolvedOutput = "";
    let validPaths = true;
    try {
      resolvedInput = resolveAllowedInputPath(inputPath);
      resolvedOutput = argument("--output")
        ? resolveAllowedOutputPath(argument("--output")!)
        : path.join(outputDir, `${id}.csv`);
    } catch (error) {
      console.error(
        error instanceof Error ? error.message : "Invalid input or output path",
      );
      process.exitCode = 1;
      validPaths = false;
    }
    if (validPaths) void runLeadJob({
      id,
      inputPath: resolvedInput,
      outputPath: resolvedOutput,
      stateDir,
      provider: argument("--provider") || "builtin",
      providerCallLimit:
        Number(argument("--provider-call-limit")) ||
        Number(process.env.LEAD_ENRICHMENT_PROVIDER_CALL_LIMIT) ||
        1000,
      batchSize:
        Number(argument("--batch-size")) ||
        Number(process.env.LEAD_ENRICHMENT_BATCH_SIZE) ||
        100,
      verifierBaseUrl,
      verifierAuthToken,
      emailColumn: argument("--email-column"),
      firstNameColumn: argument("--first-name-column"),
      lastNameColumn: argument("--last-name-column"),
      domainColumn: argument("--domain-column"),
      fullNameColumn: argument("--full-name-column"),
      llmEnabled: config.llmEnabled,
      websiteResearchEnabled: config.llmWebsiteResearchEnabled,
      excludeMissingEmail: !process.argv.includes("--retain-missing-email"),
    }).then((state) => {
      console.log(JSON.stringify(state));
    });
  }
}
