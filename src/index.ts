import express from "express";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { runLeadJob } from "./job";
import { ensureDir, loadJobStates, saveJobState } from "./state";
import type { LeadJobState } from "./types";
import { config } from "./config";
import { requireServiceAuth, resolveAllowedInputPath, resolveAllowedOutputPath } from "./security";
import { appendAudit, loadAuditEntries } from "./audit";
import { diskUsage, memoryUsage } from "./resources";
import { applyRetention, previewRetention } from "./retention";
import { getCliVersion, printCliHelp } from "./cli";

// This entry point supports two modes: a local HTTP service or a one-shot CLI job.
const app = express();
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
const cancellationRequested = new Set<string>();

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
    llmEnabled?: boolean;
    websiteResearchEnabled?: boolean;
  };
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  // Save before processing so status and progress survive an API/process restart.
  saveJobState(stateDir, initial);
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
    },
  });

  const promise = runLeadJob({
    id,
    inputPath,
    outputPath,
    stateDir,
    provider,
    providerCallLimit,
    batchSize,
    verifierBaseUrl,
    verifierAuthToken,
    emailColumn: body.emailColumn,
    firstNameColumn: body.firstNameColumn,
    lastNameColumn: body.lastNameColumn,
    domainColumn: body.domainColumn,
    llmEnabled:
      typeof body.llmEnabled === "boolean"
        ? body.llmEnabled
        : config.llmEnabled,
    websiteResearchEnabled:
      typeof body.websiteResearchEnabled === "boolean"
        ? body.websiteResearchEnabled
        : config.llmWebsiteResearchEnabled,
    initialState: initial,
    cancelRequested: () => cancellationRequested.has(id),
  }).finally(() => {
    running.delete(id);
    cancellationRequested.delete(id);
  });
  // Keep in-process status separate from the durable JSON snapshot.
  running.set(id, promise);
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

app.post("/jobs/:jobId/resume", (req, res) => {
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
  const resumed = saveJobState(stateDir, {
    ...existing,
    status: "queued",
    cancelRequested: false,
    pausedReason: undefined,
    pausedAt: undefined,
  });
  cancellationRequested.delete(jobId);
  appendAudit({
    timestamp: new Date().toISOString(),
    hostId: config.hostId,
    action: "lead_enrichment.job.resumed",
    jobId,
    status: "success",
  });

  const promise = runLeadJob({
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
    cancelRequested: () => cancellationRequested.has(jobId),
  }).finally(() => {
    running.delete(jobId);
    cancellationRequested.delete(jobId);
  });
  running.set(jobId, promise);
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
  const cancelled = saveJobState(stateDir, {
    ...existing,
    cancelRequested: true,
  });
  cancellationRequested.add(jobId);
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
  if ((existing.retryCount || 0) >= config.maxRetryAttempts) {
    res.status(429).json({ error: "Maximum retry attempts reached" });
    return;
  }
  const retried = saveJobState(stateDir, {
    ...existing,
    status: "queued",
    retryCount: (existing.retryCount || 0) + 1,
    cancelRequested: false,
  });
  cancellationRequested.delete(jobId);
  appendAudit({
    timestamp: new Date().toISOString(),
    hostId: config.hostId,
    action: "lead_enrichment.job.retry",
    jobId,
    status: "success",
  });
  const promise = runLeadJob({
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
    cancelRequested: () => cancellationRequested.has(jobId),
  }).finally(() => {
    running.delete(jobId);
    cancellationRequested.delete(jobId);
  });
  running.set(jobId, promise);
  res.status(202).json(retried);
});

app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "CSV file is required" });
    return;
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

// Determine which mode this process should run by inspecting the executable arguments.
const isCli = process.argv[1]?.endsWith("/lead-enrichment/dist/index.js") ||
  process.argv[1]?.endsWith("/lead-enrichment/src/index.ts");

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
  for (const state of loadJobStates(stateDir)) {
    if (
      ["queued", "processing", "paused"].includes(state.status) &&
      !state.cancelRequested
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
      const promise = runLeadJob({
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
        cancelRequested: () => cancellationRequested.has(resumed.id),
      }).finally(() => {
        running.delete(resumed.id);
        cancellationRequested.delete(resumed.id);
      });
      running.set(resumed.id, promise);
    }
  }
  app.listen(port, () => {
    console.log(`Lead enrichment service listening on port ${port}`);
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
      llmEnabled: config.llmEnabled,
      websiteResearchEnabled: config.llmWebsiteResearchEnabled,
    }).then((state) => {
      console.log(JSON.stringify(state));
    });
  }
}
