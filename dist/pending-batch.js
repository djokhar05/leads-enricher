"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.reconcileBatchAcknowledgements = exports.completePendingBatch = exports.deletePendingBatch = exports.savePendingBatch = exports.loadPendingBatch = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = require("node:crypto");
const location = (directory, jobId) => {
    const name = (0, node_crypto_1.createHash)("sha256").update(jobId).digest("hex");
    return node_path_1.default.join(directory, "pending-batches", `${name}.json`);
};
const syncDirectory = (directory) => {
    const fd = node_fs_1.default.openSync(directory, "r");
    try {
        node_fs_1.default.fsyncSync(fd);
    }
    finally {
        node_fs_1.default.closeSync(fd);
    }
};
const loadPendingBatch = (directory, jobId) => {
    const filename = location(directory, jobId);
    if (!node_fs_1.default.existsSync(filename))
        return undefined;
    const batch = JSON.parse(node_fs_1.default.readFileSync(filename, "utf8"));
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
exports.loadPendingBatch = loadPendingBatch;
const savePendingBatch = (directory, batch) => {
    const filename = location(directory, batch.jobId);
    const folder = node_path_1.default.dirname(filename);
    node_fs_1.default.mkdirSync(folder, { recursive: true, mode: 0o700 });
    node_fs_1.default.chmodSync(folder, 0o700);
    syncDirectory(directory);
    const temporary = `${filename}.${(0, node_crypto_1.randomUUID)()}.tmp`;
    const fd = node_fs_1.default.openSync(temporary, "wx", 0o600);
    try {
        node_fs_1.default.writeFileSync(fd, JSON.stringify(batch));
        node_fs_1.default.fsyncSync(fd);
    }
    finally {
        node_fs_1.default.closeSync(fd);
    }
    node_fs_1.default.renameSync(temporary, filename);
    syncDirectory(folder);
};
exports.savePendingBatch = savePendingBatch;
const deletePendingBatch = (directory, jobId) => {
    const filename = location(directory, jobId);
    if (!node_fs_1.default.existsSync(filename))
        return;
    node_fs_1.default.unlinkSync(filename);
    syncDirectory(node_path_1.default.dirname(filename));
};
exports.deletePendingBatch = deletePendingBatch;
const completePendingBatch = (directory, batch) => {
    if (batch.verifierCompleted) {
        const folder = node_path_1.default.join(directory, "batch-acknowledgements");
        node_fs_1.default.mkdirSync(folder, { recursive: true, mode: 0o700 });
        node_fs_1.default.chmodSync(folder, 0o700);
        syncDirectory(directory);
        const name = (0, node_crypto_1.createHash)("sha256").update(batch.requestId).digest("hex");
        const filename = node_path_1.default.join(folder, `${name}.json`);
        if (!node_fs_1.default.existsSync(filename)) {
            const temporary = `${filename}.${(0, node_crypto_1.randomUUID)()}.tmp`;
            const fd = node_fs_1.default.openSync(temporary, "wx", 0o600);
            try {
                node_fs_1.default.writeFileSync(fd, JSON.stringify({ requestId: batch.requestId, jobId: batch.jobId }));
                node_fs_1.default.fsyncSync(fd);
            }
            finally {
                node_fs_1.default.closeSync(fd);
            }
            node_fs_1.default.renameSync(temporary, filename);
            syncDirectory(folder);
        }
    }
    (0, exports.deletePendingBatch)(directory, batch.jobId);
};
exports.completePendingBatch = completePendingBatch;
const reconcileBatchAcknowledgements = async (directory, baseUrl, authToken) => {
    const pendingFolder = node_path_1.default.join(directory, "pending-batches");
    if (node_fs_1.default.existsSync(pendingFolder)) {
        for (const name of node_fs_1.default.readdirSync(pendingFolder)) {
            if (!name.endsWith(".json"))
                continue;
            const saved = JSON.parse(node_fs_1.default.readFileSync(node_path_1.default.join(pendingFolder, name), "utf8"));
            if (typeof saved !== "object" || saved === null ||
                !("jobId" in saved) || typeof saved.jobId !== "string" ||
                !saved.jobId || name !== `${(0, node_crypto_1.createHash)("sha256").update(saved.jobId).digest("hex")}.json`) {
                throw new Error(`Invalid pending enrichment batch: ${name}`);
            }
            const statePath = node_path_1.default.resolve(directory, `${saved.jobId}.json`);
            if (node_path_1.default.dirname(statePath) !== node_path_1.default.resolve(directory)) {
                throw new Error(`Invalid pending enrichment job ID: ${name}`);
            }
            if (!node_fs_1.default.existsSync(statePath)) {
                console.error("[lead-enrichment] pending batch has no job snapshot", { jobId: saved.jobId });
                continue;
            }
            const state = JSON.parse(node_fs_1.default.readFileSync(statePath, "utf8"));
            if (typeof state !== "object" || state === null ||
                !("id" in state) || state.id !== saved.jobId ||
                !("checkpointRow" in state) || !Number.isSafeInteger(state.checkpointRow) ||
                Number(state.checkpointRow) < 0) {
                throw new Error(`Invalid enrichment job snapshot for pending batch: ${name}`);
            }
            const pending = (0, exports.loadPendingBatch)(directory, saved.jobId);
            if (pending && Number(state.checkpointRow) >= pending.endRow) {
                (0, exports.completePendingBatch)(directory, pending);
            }
        }
    }
    const folder = node_path_1.default.join(directory, "batch-acknowledgements");
    if (!node_fs_1.default.existsSync(folder))
        return;
    for (const name of node_fs_1.default.readdirSync(folder)) {
        if (!name.endsWith(".json"))
            continue;
        const filename = node_path_1.default.join(folder, name);
        const record = JSON.parse(node_fs_1.default.readFileSync(filename, "utf8"));
        if (typeof record !== "object" || record === null ||
            !("requestId" in record) || typeof record.requestId !== "string" ||
            !record.requestId || name !== `${(0, node_crypto_1.createHash)("sha256").update(record.requestId).digest("hex")}.json` ||
            !("jobId" in record) || typeof record.jobId !== "string" || !record.jobId) {
            throw new Error(`Invalid verifier acknowledgement record: ${name}`);
        }
        try {
            const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/batches/${encodeURIComponent(record.requestId)}/acknowledge`, {
                method: "POST",
                headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
                signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok)
                throw new Error(`HTTP ${response.status}`);
            node_fs_1.default.unlinkSync(filename);
            syncDirectory(folder);
        }
        catch (error) {
            console.error("[lead-enrichment] verifier batch acknowledgement failed", {
                jobId: record.jobId, requestId: record.requestId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
};
exports.reconcileBatchAcknowledgements = reconcileBatchAcknowledgements;
