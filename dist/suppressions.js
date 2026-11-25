"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSuppressed = exports.loadSuppressions = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const sync_1 = require("csv-parse/sync");
const config_1 = require("./config");
let loadedPath = "";
let suppressions = new Set();
const normalize = (email) => email.trim().toLowerCase();
const loadSuppressions = () => {
    if (!config_1.config.suppressionsPath)
        return suppressions;
    if (loadedPath === config_1.config.suppressionsPath && suppressions.size >= 0) {
        return suppressions;
    }
    if (!node_fs_1.default.existsSync(config_1.config.suppressionsPath)) {
        suppressions = new Set();
        loadedPath = config_1.config.suppressionsPath;
        return suppressions;
    }
    const records = (0, sync_1.parse)(node_fs_1.default.readFileSync(config_1.config.suppressionsPath), {
        bom: true,
        columns: true,
        relax_column_count: true,
    });
    suppressions = new Set(records
        .flatMap((record) => Object.entries(record)
        .filter(([key]) => /email|address/i.test(key))
        .map(([, value]) => normalize(String(value || ""))))
        .filter(Boolean));
    loadedPath = config_1.config.suppressionsPath;
    return suppressions;
};
exports.loadSuppressions = loadSuppressions;
const isSuppressed = (email) => (0, exports.loadSuppressions)().has(normalize(email));
exports.isSuppressed = isSuppressed;
