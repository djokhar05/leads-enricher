"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveAllowedOutputPath = exports.resolveAllowedInputPath = exports.requireServiceAuth = void 0;
const node_path_1 = __importDefault(require("node:path"));
const config_1 = require("./config");
const requireServiceAuth = (req, res, next) => {
    if (!config_1.config.authToken) {
        res.status(503).json({
            error: "LEAD_ENRICHMENT_AUTH_TOKEN is required",
        });
        return;
    }
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ")
        ? header.slice("Bearer ".length)
        : "";
    if (token !== config_1.config.authToken) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    next();
};
exports.requireServiceAuth = requireServiceAuth;
const inside = (root, target) => {
    const relative = node_path_1.default.relative(node_path_1.default.resolve(root), node_path_1.default.resolve(target));
    return relative === "" ||
        (!relative.startsWith("..") && !node_path_1.default.isAbsolute(relative));
};
const resolveAllowedInputPath = (inputPath) => {
    const resolved = node_path_1.default.resolve(inputPath);
    if (!inside(config_1.config.inputDir, resolved)) {
        throw new Error("Input path is outside the allowed input directory");
    }
    return resolved;
};
exports.resolveAllowedInputPath = resolveAllowedInputPath;
const resolveAllowedOutputPath = (outputPath) => {
    const resolved = node_path_1.default.resolve(outputPath);
    if (!inside(config_1.config.outputDir, resolved)) {
        throw new Error("Output path is outside the allowed output directory");
    }
    return resolved;
};
exports.resolveAllowedOutputPath = resolveAllowedOutputPath;
