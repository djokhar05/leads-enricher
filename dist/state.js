"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadJobStates = exports.saveJobState = exports.atomicWriteJson = exports.ensureDir = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
// Creates host-local state, input, or output directories recursively.
const ensureDir = (directory) => {
    node_fs_1.default.mkdirSync(directory, { recursive: true });
};
exports.ensureDir = ensureDir;
// JSON state is written to a temporary file and renamed so readers observe
// a complete snapshot instead of partially written job metadata.
const atomicWriteJson = (filePath, value) => {
    (0, exports.ensureDir)(node_path_1.default.dirname(filePath));
    const temporary = `${filePath}.tmp`;
    node_fs_1.default.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    node_fs_1.default.renameSync(temporary, filePath);
};
exports.atomicWriteJson = atomicWriteJson;
// Updates the timestamp and atomically replaces one job snapshot.
const saveJobState = (directory, state) => {
    (0, exports.ensureDir)(directory);
    const updated = { ...state, updatedAt: new Date().toISOString() };
    (0, exports.atomicWriteJson)(node_path_1.default.join(directory, `${state.id}.json`), updated);
    return updated;
};
exports.saveJobState = saveJobState;
// Job listings are derived from durable local JSON files, not process memory.
const loadJobStates = (directory) => {
    if (!node_fs_1.default.existsSync(directory))
        return [];
    return node_fs_1.default
        .readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
        try {
            return JSON.parse(node_fs_1.default.readFileSync(node_path_1.default.join(directory, name), "utf8"));
        }
        catch {
            return null;
        }
    })
        .filter((state) => state !== null)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};
exports.loadJobStates = loadJobStates;
