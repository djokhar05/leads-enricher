"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadAuditEntries = exports.appendAudit = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const config_1 = require("./config");
const appendAudit = (entry) => {
    node_fs_1.default.mkdirSync(config_1.config.auditDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    node_fs_1.default.appendFileSync(node_path_1.default.join(config_1.config.auditDir, `${date}.jsonl`), `${JSON.stringify(entry)}\n`, "utf8");
};
exports.appendAudit = appendAudit;
const loadAuditEntries = (limit = 200) => {
    if (!node_fs_1.default.existsSync(config_1.config.auditDir))
        return [];
    const entries = [];
    for (const name of node_fs_1.default.readdirSync(config_1.config.auditDir)
        .filter((item) => item.endsWith(".jsonl"))
        .sort()
        .reverse()) {
        try {
            const lines = node_fs_1.default.readFileSync(node_path_1.default.join(config_1.config.auditDir, name), "utf8")
                .split("\n")
                .filter(Boolean)
                .reverse();
            for (const line of lines) {
                entries.push(JSON.parse(line));
                if (entries.length >= limit)
                    return entries;
            }
        }
        catch {
            // Leave malformed audit lines untouched for operator inspection.
        }
    }
    return entries;
};
exports.loadAuditEntries = loadAuditEntries;
