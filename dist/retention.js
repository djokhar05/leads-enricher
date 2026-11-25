"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyRetention = exports.previewRetention = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const config_1 = require("./config");
const state_1 = require("./state");
const previewRetention = () => {
    const cutoffMs = Date.now() - config_1.config.retentionDays * 24 * 60 * 60 * 1000;
    const cutoff = new Date(cutoffMs).toISOString();
    const jobs = (0, state_1.loadJobStates)(config_1.config.stateDir)
        .filter((job) => ["completed", "failed"].includes(job.status) &&
        new Date(job.updatedAt).getTime() < cutoffMs)
        .map((job) => ({
        id: job.id,
        status: job.status,
        updatedAt: job.updatedAt,
        inputPath: job.inputPath,
        outputPath: job.outputPath,
    }));
    const files = [];
    for (const job of jobs) {
        for (const target of [job.inputPath, job.outputPath]) {
            if (!target || !node_fs_1.default.existsSync(target))
                continue;
            const stat = node_fs_1.default.statSync(target);
            if (stat.isFile())
                files.push(target);
        }
    }
    return { cutoff, jobs, files };
};
exports.previewRetention = previewRetention;
const applyRetention = () => {
    const preview = (0, exports.previewRetention)();
    for (const job of preview.jobs) {
        const snapshot = node_path_1.default.join(config_1.config.stateDir, `${job.id}.json`);
        if (node_fs_1.default.existsSync(snapshot))
            node_fs_1.default.unlinkSync(snapshot);
    }
    for (const file of preview.files) {
        node_fs_1.default.unlinkSync(file);
    }
    return preview;
};
exports.applyRetention = applyRetention;
