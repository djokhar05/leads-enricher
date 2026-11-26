"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = void 0;
const express_1 = __importDefault(require("express"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = require("node:crypto");
const multer_1 = __importDefault(require("multer"));
const job_1 = require("./job");
const state_1 = require("./state");
const pending_batch_1 = require("./pending-batch");
const config_1 = require("./config");
const security_1 = require("./security");
const audit_1 = require("./audit");
const resources_1 = require("./resources");
const retention_1 = require("./retention");
const cli_1 = require("./cli");
const csv_1 = require("./csv");
const provider_adapters_1 = require("./provider-adapters");
// This entry point supports two modes: a local HTTP service or a one-shot CLI job.
exports.app = (0, express_1.default)();
exports.app.use(express_1.default.json({ limit: "2mb" }));
// All files and durable state stay on the enrichment host; nothing is uploaded to S3.
const stateDir = config_1.config.stateDir;
const inputDir = config_1.config.inputDir;
const outputDir = config_1.config.outputDir;
const verifierBaseUrl = config_1.config.verifierBaseUrl;
const verifierAuthToken = config_1.config.verifierAuthToken;
const port = config_1.config.port;
(0, state_1.ensureDir)(stateDir);
(0, state_1.ensureDir)(inputDir);
(0, state_1.ensureDir)(outputDir);
exports.app.use(security_1.requireServiceAuth);
// Track only jobs currently running in this process. Durable job state is read from disk.
const running = new Map();
const cancellationControllers = new Map();
const startTrackedJob = (options) => {
    const controller = new AbortController();
    cancellationControllers.set(options.id, controller);
    const promise = (0, job_1.runLeadJob)({ ...options, signal: controller.signal }).finally(() => {
        running.delete(options.id);
        cancellationControllers.delete(options.id);
    });
    running.set(options.id, promise);
};
const upload = (0, multer_1.default)({
    storage: multer_1.default.diskStorage({
        destination: (_req, _file, callback) => callback(null, inputDir),
        filename: (_req, file, callback) => callback(null, `${Date.now()}-${(0, node_crypto_1.randomUUID)()}-${node_path_1.default.basename(file.originalname)}`),
    }),
    limits: { fileSize: config_1.config.maxUploadBytes },
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
exports.app.get("/health", async (_req, res) => {
    let verifier;
    if (verifierBaseUrl) {
        try {
            const verifierResponse = await fetch(`${verifierBaseUrl.replace(/\/$/, "")}/api/health`, {
                headers: verifierAuthToken
                    ? { Authorization: `Bearer ${verifierAuthToken}` }
                    : {},
                signal: AbortSignal.timeout(5_000),
            });
            if (verifierResponse.ok) {
                const payload = await verifierResponse.json();
                verifier = {
                    reachable: true,
                    status: payload.status,
                    queue: payload.queue,
                    providers: payload.providers,
                };
            }
            else {
                verifier = {
                    reachable: false,
                    error: `Verifier returned HTTP ${verifierResponse.status}`,
                };
            }
        }
        catch (error) {
            verifier = {
                reachable: false,
                error: error instanceof Error
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
        maxConcurrentJobs: config_1.config.maxConcurrentJobs,
        memory: (0, resources_1.memoryUsage)(),
        disk: (0, resources_1.diskUsage)(outputDir),
        diskMinimumBytes: config_1.config.minFreeDiskBytes,
        auditEntries: (0, audit_1.loadAuditEntries)(20),
        ai: {
            enabled: config_1.config.llmEnabled,
            provider: config_1.config.llmProvider,
            model: config_1.config.llmModel,
            fallbackProvider: config_1.config.llmFallbackProvider,
            fallbackModel: config_1.config.llmFallbackModel,
            websiteResearchEnabled: config_1.config.llmWebsiteResearchEnabled,
            primaryKeyConfigured: Boolean(config_1.config.llmApiKey),
            fallbackKeyConfigured: Boolean(config_1.config.llmFallbackApiKey),
        },
        verifier,
    });
});
exports.app.post("/ai/test", async (_req, res) => {
    const result = await (0, provider_adapters_1.testLlmConnection)();
    res.status(result.ok ? 200 : 503).json(result);
});
exports.app.get("/jobs", (_req, res) => {
    res.json({ jobs: (0, state_1.loadJobStates)(stateDir) });
});
// Look up one persisted job and its latest checkpoint/progress.
exports.app.get("/jobs/:jobId", (req, res) => {
    const jobId = String(req.params.jobId);
    const job = (0, state_1.loadJobStates)(stateDir).find((item) => item.id === jobId);
    if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
    }
    res.json(job);
});
exports.app.get("/jobs/:jobId/output", (req, res) => {
    const jobId = String(req.params.jobId);
    const job = (0, state_1.loadJobStates)(stateDir).find((item) => item.id === jobId);
    if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
    }
    if (!node_fs_1.default.existsSync(job.outputPath)) {
        res.status(404).json({ error: "Output not found" });
        return;
    }
    res.download(job.outputPath);
});
exports.app.post("/jobs", (req, res) => {
    console.info("[lead-enrichment] POST /jobs received", {
        provider: typeof req.body?.provider === "string"
            ? req.body.provider
            : "builtin",
        batchSize: Number(req.body?.batchSize) || config_1.config.batchSize,
    });
    // A new job receives explicit column mappings when the CSV does not contain
    // one of the standard email/name/domain fields.
    const body = req.body;
    if (body.excludeMissingEmail !== undefined &&
        typeof body.excludeMissingEmail !== "boolean") {
        res.status(400).json({ error: "excludeMissingEmail must be a boolean" });
        return;
    }
    if (body.skipUncertainChecks !== undefined &&
        typeof body.skipUncertainChecks !== "boolean") {
        res.status(400).json({ error: "skipUncertainChecks must be a boolean" });
        return;
    }
    if (!body.inputPath) {
        res.status(400).json({ error: "inputPath is required" });
        return;
    }
    let inputPath;
    let outputPath;
    try {
        inputPath = (0, security_1.resolveAllowedInputPath)(body.inputPath);
    }
    catch (error) {
        res.status(400).json({
            error: error instanceof Error ? error.message : "Invalid input path",
        });
        return;
    }
    if (!node_fs_1.default.existsSync(inputPath)) {
        res.status(404).json({ error: "Input CSV not found" });
        return;
    }
    if (running.size >= config_1.config.maxConcurrentJobs) {
        res.status(429).json({ error: "Maximum concurrent enrichment jobs reached" });
        return;
    }
    const disk = (0, resources_1.diskUsage)(outputDir);
    if (!("unavailable" in disk) &&
        disk.freeBytes < config_1.config.minFreeDiskBytes) {
        res.status(503).json({
            error: "Insufficient local disk space",
            freeBytes: disk.freeBytes,
            minimumFreeBytes: config_1.config.minFreeDiskBytes,
        });
        return;
    }
    const id = (0, node_crypto_1.randomUUID)();
    try {
        outputPath = body.outputPath
            ? (0, security_1.resolveAllowedOutputPath)(body.outputPath)
            : node_path_1.default.join(outputDir, `${id}.csv`);
    }
    catch (error) {
        res.status(400).json({
            error: error instanceof Error ? error.message : "Invalid output path",
        });
        return;
    }
    const provider = typeof body.provider === "string" ? body.provider : "builtin";
    const providerCallLimit = Number.isInteger(body.providerCallLimit) &&
        Number(body.providerCallLimit) >= 0
        ? Number(body.providerCallLimit)
        : Number(process.env.LEAD_ENRICHMENT_PROVIDER_CALL_LIMIT) || 1000;
    const batchSize = Number.isInteger(body.batchSize) && Number(body.batchSize) > 0
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
        llmEnabled: typeof body.llmEnabled === "boolean" ? body.llmEnabled : config_1.config.llmEnabled,
        websiteResearchEnabled: typeof body.websiteResearchEnabled === "boolean"
            ? body.websiteResearchEnabled
            : config_1.config.llmWebsiteResearchEnabled,
        excludeMissingEmail: body.excludeMissingEmail ?? true,
        skipUncertainChecks: body.skipUncertainChecks ?? false,
    };
    const initial = {
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
    (0, state_1.saveJobState)(stateDir, initial);
    console.info("[lead-enrichment] job queued", {
        jobId: id,
        provider,
        batchSize,
        excludeMissingEmail: settings.excludeMissingEmail,
    });
    (0, audit_1.appendAudit)({
        timestamp: new Date().toISOString(),
        hostId: config_1.config.hostId,
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
exports.app.get("/files", (_req, res) => {
    const listDirectory = (directory) => node_fs_1.default.existsSync(directory)
        ? node_fs_1.default.readdirSync(directory)
            .map((name) => {
            const target = node_path_1.default.join(directory, name);
            const stat = node_fs_1.default.statSync(target);
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
exports.app.delete("/files", (req, res) => {
    const requestedPath = typeof req.body?.path === "string" ? req.body.path : "";
    if (!requestedPath) {
        res.status(400).json({ error: "File path is required" });
        return;
    }
    let resolvedPath;
    try {
        const absolute = node_path_1.default.resolve(requestedPath);
        const relativeToInput = node_path_1.default.relative(node_path_1.default.resolve(inputDir), absolute);
        const relativeToOutput = node_path_1.default.relative(node_path_1.default.resolve(outputDir), absolute);
        const insideInput = relativeToInput === "" ||
            (!relativeToInput.startsWith("..") && !node_path_1.default.isAbsolute(relativeToInput));
        const insideOutput = relativeToOutput === "" ||
            (!relativeToOutput.startsWith("..") && !node_path_1.default.isAbsolute(relativeToOutput));
        if (!insideInput && !insideOutput) {
            res.status(400).json({
                error: "File is outside the configured input/output directories",
            });
            return;
        }
        resolvedPath = absolute;
    }
    catch {
        res.status(400).json({ error: "Invalid file path" });
        return;
    }
    if (!node_fs_1.default.existsSync(resolvedPath) || !node_fs_1.default.statSync(resolvedPath).isFile()) {
        res.status(404).json({ error: "File not found" });
        return;
    }
    const activeJobs = (0, state_1.loadJobStates)(stateDir).filter((job) => ["queued", "processing", "paused"].includes(job.status));
    const referencedByActiveJob = activeJobs.some((job) => node_path_1.default.resolve(job.inputPath) === resolvedPath ||
        node_path_1.default.resolve(job.outputPath) === resolvedPath);
    if (referencedByActiveJob) {
        res.status(409).json({
            error: "File belongs to an active enrichment job",
        });
        return;
    }
    node_fs_1.default.unlinkSync(resolvedPath);
    for (const job of (0, state_1.loadJobStates)(stateDir)) {
        let changed = false;
        const update = { ...job };
        if (node_path_1.default.resolve(job.inputPath) === resolvedPath) {
            update.inputDeleted = true;
            changed = true;
        }
        if (node_path_1.default.resolve(job.outputPath) === resolvedPath) {
            update.outputDeleted = true;
            changed = true;
        }
        if (changed)
            (0, state_1.saveJobState)(stateDir, update);
    }
    (0, audit_1.appendAudit)({
        timestamp: new Date().toISOString(),
        hostId: config_1.config.hostId,
        action: "lead_enrichment.file.deleted",
        status: "success",
        metadata: { path: resolvedPath },
    });
    res.json({ deleted: true, path: resolvedPath });
});
exports.app.get("/jobs/:jobId/review", async (req, res) => {
    const jobId = String(req.params.jobId);
    const job = (0, state_1.loadJobStates)(stateDir).find((state) => state.id === jobId);
    if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
    }
    const pending = (0, pending_batch_1.loadPendingBatch)(stateDir, jobId);
    if (job.pausedReason !== job_1.VERIFIER_REVIEW_REQUIRED || !pending) {
        res.status(409).json({ error: "This job has no recoverable batch awaiting review" });
        return;
    }
    try {
        const response = await fetch(`${verifierBaseUrl.replace(/\/$/, "")}/api/batches/${encodeURIComponent(pending.requestId)}/review`, {
            headers: verifierAuthToken ? { Authorization: `Bearer ${verifierAuthToken}` } : {},
            signal: AbortSignal.timeout(10_000),
        });
        if (response.status === 409) {
            const statusResponse = await fetch(`${verifierBaseUrl.replace(/\/$/, "")}/api/batches/${encodeURIComponent(pending.requestId)}`, {
                headers: verifierAuthToken ? { Authorization: `Bearer ${verifierAuthToken}` } : {},
                signal: AbortSignal.timeout(10_000),
            });
            if (statusResponse.ok) {
                const status = await statusResponse.json();
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
    }
    catch (error) {
        console.error("[lead-enrichment] unable to load batch review", {
            jobId, error: error instanceof Error ? error.message : String(error),
        });
        res.status(502).json({ error: "Unable to load verifier batch review" });
    }
});
exports.app.post("/jobs/:jobId/review", async (req, res) => {
    const jobId = String(req.params.jobId);
    const job = (0, state_1.loadJobStates)(stateDir).find((state) => state.id === jobId);
    if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
    }
    if (running.has(jobId) || job.pausedReason !== job_1.VERIFIER_REVIEW_REQUIRED) {
        res.status(409).json({ error: "Job is not waiting for a verifier review" });
        return;
    }
    const pending = (0, pending_batch_1.loadPendingBatch)(stateDir, jobId);
    const token = req.body?.token;
    const action = req.body?.action;
    const skipAllUncertain = req.body?.skipAllUncertain === true;
    if (!pending || typeof token !== "string" || !token || !["skip", "retry"].includes(String(action)) ||
        (action === "retry" && req.body?.confirmDuplicateCharge !== true)) {
        res.status(400).json({ error: "A pending batch, review token and action are required; retry also requires duplicate-charge confirmation" });
        return;
    }
    try {
        const response = await fetch(`${verifierBaseUrl.replace(/\/$/, "")}/api/batches/${encodeURIComponent(pending.requestId)}/review`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(verifierAuthToken ? { Authorization: `Bearer ${verifierAuthToken}` } : {}),
            },
            body: JSON.stringify({ token, action, confirmDuplicateCharge: req.body?.confirmDuplicateCharge }),
            signal: AbortSignal.timeout(10_000),
        });
        const payload = await response.json();
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
            const settings = job.settings
                ? { ...job.settings, skipUncertainChecks: action === "skip" && skipAllUncertain }
                : job.settings;
            const resumed = (0, state_1.saveJobState)(stateDir, {
                ...job,
                settings,
                status: "queued",
                cancelRequested: false,
                pausedReason: undefined,
                pausedAt: undefined,
                error: undefined,
            });
            (0, audit_1.appendAudit)({
                timestamp: new Date().toISOString(),
                hostId: config_1.config.hostId,
                action: "lead_enrichment.job.resumed",
                jobId,
                status: "success",
                metadata: {
                    after: "batch_review",
                    decision: action,
                    skipAllUncertain,
                },
            });
            startTrackedJob({
                id: resumed.id,
                inputPath: resumed.inputPath,
                outputPath: resumed.outputPath,
                stateDir,
                provider: resumed.provider,
                providerCallLimit: resumed.settings?.providerCallLimit ?? config_1.config.providerCallLimit,
                batchSize: resumed.settings?.batchSize ?? config_1.config.batchSize,
                verifierBaseUrl,
                verifierAuthToken,
                initialState: resumed,
                llmEnabled: resumed.settings?.llmEnabled ?? config_1.config.llmEnabled,
                websiteResearchEnabled: resumed.settings?.websiteResearchEnabled ?? config_1.config.llmWebsiteResearchEnabled,
                skipUncertainChecks: resumed.settings?.skipUncertainChecks ?? false,
            });
        }
        (0, audit_1.appendAudit)({
            timestamp: new Date().toISOString(),
            hostId: config_1.config.hostId,
            action: "lead_enrichment.batch.reviewed",
            jobId,
            status: "success",
            metadata: { decision: action },
        });
        res.json(payload);
    }
    catch (error) {
        console.error("[lead-enrichment] unable to submit batch review", {
            jobId, error: error instanceof Error ? error.message : String(error),
        });
        res.status(502).json({ error: "Unable to submit verifier batch review; retry the same decision" });
    }
});
exports.app.post("/jobs/:jobId/resume", async (req, res) => {
    const jobId = String(req.params.jobId);
    const existing = (0, state_1.loadJobStates)(stateDir).find((job) => job.id === jobId);
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
    if ((0, pending_batch_1.loadPendingBatch)(stateDir, jobId)) {
        const pending = (0, pending_batch_1.loadPendingBatch)(stateDir, jobId);
        if (!pending) {
            res.status(409).json({ error: "The pending verifier batch is missing; operator review is required" });
            return;
        }
        try {
            const response = await fetch(`${verifierBaseUrl.replace(/\/$/, "")}/api/batches/${encodeURIComponent(pending.requestId)}`, {
                headers: verifierAuthToken ? { Authorization: `Bearer ${verifierAuthToken}` } : {},
                signal: AbortSignal.timeout(10_000),
            });
            const batch = await response.json();
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
        }
        catch (error) {
            console.error("[lead-enrichment] unable to reconnect verifier batch", {
                jobId, requestId: pending.requestId,
                error: error instanceof Error ? error.message : String(error),
            });
            res.status(502).json({ error: "Unable to reconnect to the verifier batch" });
            return;
        }
    }
    const latest = (0, state_1.loadJobStates)(stateDir).find((job) => job.id === jobId);
    if (running.has(jobId) || !latest || latest.updatedAt !== existing.updatedAt) {
        res.status(409).json({ error: "Job changed while the verifier was being checked; refresh and try again" });
        return;
    }
    const resumed = (0, state_1.saveJobState)(stateDir, {
        ...existing,
        status: "queued",
        cancelRequested: false,
        pausedReason: undefined,
        pausedAt: undefined,
        error: undefined,
    });
    (0, audit_1.appendAudit)({
        timestamp: new Date().toISOString(),
        hostId: config_1.config.hostId,
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
        providerCallLimit: config_1.config.providerCallLimit,
        batchSize: config_1.config.batchSize,
        verifierBaseUrl,
        verifierAuthToken,
        initialState: resumed,
        llmEnabled: config_1.config.llmEnabled,
        websiteResearchEnabled: config_1.config.llmWebsiteResearchEnabled,
    });
    res.status(202).json(resumed);
});
exports.app.post("/jobs/:jobId/cancel", (req, res) => {
    const jobId = String(req.params.jobId);
    const existing = (0, state_1.loadJobStates)(stateDir).find((job) => job.id === jobId);
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
    const cancelled = (0, state_1.saveJobState)(stateDir, {
        ...existing,
        cancelRequested: true,
        ...(!running.has(jobId) ? {
            status: "cancelled",
            error: "Cancelled by operator",
        } : {}),
    });
    cancellationControllers.get(jobId)?.abort();
    (0, audit_1.appendAudit)({
        timestamp: new Date().toISOString(),
        hostId: config_1.config.hostId,
        action: "lead_enrichment.job.cancel_requested",
        jobId,
        status: "success",
    });
    res.json(cancelled);
});
exports.app.post("/jobs/:jobId/retry", (req, res) => {
    const jobId = String(req.params.jobId);
    const existing = (0, state_1.loadJobStates)(stateDir).find((job) => job.id === jobId);
    if (!existing) {
        res.status(404).json({ error: "Job not found" });
        return;
    }
    if (!["failed", "paused"].includes(existing.status)) {
        res.status(409).json({ error: "Only failed or paused jobs can retry" });
        return;
    }
    if (existing.pausedReason === job_1.VERIFIER_REVIEW_REQUIRED) {
        res.status(409).json({ error: "Verifier outcome requires operator review; automatic retry could duplicate paid checks" });
        return;
    }
    if ((existing.retryCount || 0) >= config_1.config.maxRetryAttempts) {
        res.status(429).json({ error: "Maximum retry attempts reached" });
        return;
    }
    const retried = (0, state_1.saveJobState)(stateDir, {
        ...existing,
        status: "queued",
        retryCount: (existing.retryCount || 0) + 1,
        cancelRequested: false,
        error: undefined,
    });
    (0, audit_1.appendAudit)({
        timestamp: new Date().toISOString(),
        hostId: config_1.config.hostId,
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
        providerCallLimit: config_1.config.providerCallLimit,
        batchSize: config_1.config.batchSize,
        verifierBaseUrl,
        verifierAuthToken,
        initialState: retried,
        llmEnabled: config_1.config.llmEnabled,
        websiteResearchEnabled: config_1.config.llmWebsiteResearchEnabled,
    });
    res.status(202).json(retried);
});
exports.app.post("/upload", upload.single("file"), async (req, res) => {
    if (!req.file) {
        res.status(400).json({ error: "CSV file is required" });
        return;
    }
    console.info("[lead-enrichment] POST /upload received", {
        fileName: req.file.filename,
        sizeBytes: req.file.size,
    });
    let mappings = null;
    try {
        const stream = node_fs_1.default.createReadStream(req.file.path);
        const { parse } = await Promise.resolve().then(() => __importStar(require("csv-parse")));
        const parser = stream.pipe(parse({
            bom: true,
            columns: false,
            relax_column_count: true,
            skip_empty_lines: true,
            to_line: 1,
        }));
        for await (const record of parser) {
            if (Array.isArray(record)) {
                mappings = (0, csv_1.detectCsvHeaderMappings)(record.map((value) => String(value || "")));
            }
            break;
        }
    }
    catch {
        mappings = null;
    }
    (0, audit_1.appendAudit)({
        timestamp: new Date().toISOString(),
        hostId: config_1.config.hostId,
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
exports.app.get("/resources", (_req, res) => {
    res.json({
        memory: (0, resources_1.memoryUsage)(),
        disk: (0, resources_1.diskUsage)(outputDir),
        activeJobs: running.size,
        maxConcurrentJobs: config_1.config.maxConcurrentJobs,
    });
});
exports.app.get("/audit", (req, res) => {
    const requested = Number(req.query.limit);
    res.json({
        entries: (0, audit_1.loadAuditEntries)(Number.isInteger(requested) && requested > 0
            ? Math.min(requested, 500)
            : 200),
    });
});
exports.app.get("/retention/preview", (_req, res) => {
    res.json((0, retention_1.previewRetention)());
});
exports.app.post("/retention/apply", (_req, res) => {
    const preview = (0, retention_1.applyRetention)();
    (0, audit_1.appendAudit)({
        timestamp: new Date().toISOString(),
        hostId: config_1.config.hostId,
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
if (isCli &&
    process.argv.some((argument) => argument === "-h" || argument === "--help")) {
    console.log((0, cli_1.printCliHelp)());
    process.exitCode = 0;
}
else if (isCli &&
    process.argv.some((argument) => argument === "-v" || argument === "--version")) {
    console.log((0, cli_1.getCliVersion)());
    process.exitCode = 0;
    // API server mode is explicitly selected to avoid starting a port for every CLI invocation.
}
else if (isCli && process.argv.includes("--serve")) {
    let acknowledging = false;
    const acknowledgeBatches = () => {
        if (acknowledging)
            return;
        acknowledging = true;
        void (0, pending_batch_1.reconcileBatchAcknowledgements)(stateDir, verifierBaseUrl, verifierAuthToken)
            .catch((error) => console.error("[lead-enrichment] batch acknowledgement recovery failed", {
            error: error instanceof Error ? error.message : String(error),
        }))
            .finally(() => { acknowledging = false; });
    };
    acknowledgeBatches();
    const acknowledgementTimer = setInterval(acknowledgeBatches, 60_000);
    acknowledgementTimer.unref();
    for (const state of (0, state_1.loadJobStates)(stateDir)) {
        if (state.cancelRequested &&
            ["queued", "processing", "paused"].includes(state.status)) {
            if ((0, pending_batch_1.loadPendingBatch)(stateDir, state.id)) {
                (0, state_1.saveJobState)(stateDir, {
                    ...state,
                    status: "paused",
                    pausedReason: job_1.VERIFIER_REVIEW_REQUIRED,
                    pausedAt: new Date().toISOString(),
                    error: "Cancellation was interrupted; the verifier batch and its billing require operator review",
                });
                continue;
            }
            (0, state_1.saveJobState)(stateDir, {
                ...state,
                status: "cancelled",
                error: "Cancelled by operator",
            });
            continue;
        }
        if (["queued", "processing", "paused"].includes(state.status) &&
            !state.cancelRequested &&
            state.pausedReason !== job_1.VERIFIER_REVIEW_REQUIRED) {
            if (running.size >= config_1.config.maxConcurrentJobs)
                break;
            const resumed = (0, state_1.saveJobState)(stateDir, {
                ...state,
                status: "queued",
                pausedReason: undefined,
                pausedAt: undefined,
            });
            (0, audit_1.appendAudit)({
                timestamp: new Date().toISOString(),
                hostId: config_1.config.hostId,
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
                providerCallLimit: config_1.config.providerCallLimit,
                batchSize: config_1.config.batchSize,
                verifierBaseUrl,
                verifierAuthToken,
                initialState: resumed,
                llmEnabled: config_1.config.llmEnabled,
                websiteResearchEnabled: config_1.config.llmWebsiteResearchEnabled,
            });
        }
    }
    const server = exports.app.listen(port, () => {
        console.log(`Lead enrichment service listening on port ${port}`);
    });
    server.on("error", (error) => {
        if (error &&
            "code" in error &&
            error.code === "EADDRINUSE") {
            void fetch(`http://127.0.0.1:${port}/health`, {
                headers: config_1.config.authToken
                    ? { Authorization: `Bearer ${config_1.config.authToken}` }
                    : {},
                signal: AbortSignal.timeout(3_000),
            }).then((response) => {
                if (response.ok) {
                    console.info(`[lead-enrichment] port ${port} already has a healthy enrichment service; reusing existing process`);
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
}
else if (isCli) {
    // Minimal argument parser for one-shot local CSV processing.
    const argument = (name) => {
        const index = process.argv.indexOf(name);
        return index >= 0 ? process.argv[index + 1] : undefined;
    };
    const inputPath = argument("--input");
    if (!inputPath) {
        console.error("Usage: lead-enrichment --input <csv> [--output <csv>] [--provider builtin]");
        process.exitCode = 1;
    }
    else {
        const id = (0, node_crypto_1.randomUUID)();
        let resolvedInput = "";
        let resolvedOutput = "";
        let validPaths = true;
        try {
            resolvedInput = (0, security_1.resolveAllowedInputPath)(inputPath);
            resolvedOutput = argument("--output")
                ? (0, security_1.resolveAllowedOutputPath)(argument("--output"))
                : node_path_1.default.join(outputDir, `${id}.csv`);
        }
        catch (error) {
            console.error(error instanceof Error ? error.message : "Invalid input or output path");
            process.exitCode = 1;
            validPaths = false;
        }
        if (validPaths)
            void (0, job_1.runLeadJob)({
                id,
                inputPath: resolvedInput,
                outputPath: resolvedOutput,
                stateDir,
                provider: argument("--provider") || "builtin",
                providerCallLimit: Number(argument("--provider-call-limit")) ||
                    Number(process.env.LEAD_ENRICHMENT_PROVIDER_CALL_LIMIT) ||
                    1000,
                batchSize: Number(argument("--batch-size")) ||
                    Number(process.env.LEAD_ENRICHMENT_BATCH_SIZE) ||
                    100,
                verifierBaseUrl,
                verifierAuthToken,
                emailColumn: argument("--email-column"),
                firstNameColumn: argument("--first-name-column"),
                lastNameColumn: argument("--last-name-column"),
                domainColumn: argument("--domain-column"),
                fullNameColumn: argument("--full-name-column"),
                llmEnabled: config_1.config.llmEnabled,
                websiteResearchEnabled: config_1.config.llmWebsiteResearchEnabled,
                excludeMissingEmail: !process.argv.includes("--retain-missing-email"),
            }).then((state) => {
                console.log(JSON.stringify(state));
            });
    }
}
