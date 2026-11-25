"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.memoryUsage = exports.diskUsage = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const diskUsage = (directory) => {
    try {
        const stats = node_fs_1.default.statfsSync(directory);
        const blockSize = Number(stats.bsize || 0);
        const total = blockSize * Number(stats.blocks || 0);
        const free = blockSize * Number(stats.bavail || 0);
        return {
            totalBytes: total,
            freeBytes: free,
            usedBytes: Math.max(total - free, 0),
            usagePercent: total > 0
                ? Math.round(((total - free) / total) * 100)
                : 0,
        };
    }
    catch {
        return {
            totalBytes: 0,
            freeBytes: 0,
            usedBytes: 0,
            usagePercent: 0,
            unavailable: true,
        };
    }
};
exports.diskUsage = diskUsage;
const memoryUsage = () => {
    const usage = process.memoryUsage();
    return {
        rssBytes: usage.rss,
        heapUsedBytes: usage.heapUsed,
        heapTotalBytes: usage.heapTotal,
        externalBytes: usage.external,
        arrayBuffersBytes: usage.arrayBuffers,
    };
};
exports.memoryUsage = memoryUsage;
