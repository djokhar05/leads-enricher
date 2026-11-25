"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const node_path_1 = __importDefault(require("node:path"));
dotenv_1.default.config();
const integer = (name, fallback, minimum = 0) => {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value >= minimum ? value : fallback;
};
exports.config = {
    port: integer("PORT", 3002, 1),
    authToken: process.env.LEAD_ENRICHMENT_AUTH_TOKEN?.trim() || "",
    stateDir: process.env.LEAD_ENRICHMENT_STATE_DIR?.trim() ||
        node_path_1.default.resolve(process.cwd(), "data", "jobs"),
    inputDir: process.env.LEAD_ENRICHMENT_INPUT_DIR?.trim() ||
        node_path_1.default.resolve(process.cwd(), "data", "input"),
    outputDir: process.env.LEAD_ENRICHMENT_OUTPUT_DIR?.trim() ||
        node_path_1.default.resolve(process.cwd(), "data", "output"),
    auditDir: process.env.LEAD_ENRICHMENT_AUDIT_DIR?.trim() ||
        node_path_1.default.resolve(process.cwd(), "data", "audit"),
    suppressionsPath: process.env.LEAD_ENRICHMENT_SUPPRESSIONS_PATH?.trim() || "",
    verifierBaseUrl: process.env.VERIFIER_BASE_URL?.trim() || "http://127.0.0.1:3001",
    verifierAuthToken: process.env.VERIFIER_AUTH_TOKEN?.trim() || "",
    providerCallLimit: integer("LEAD_ENRICHMENT_PROVIDER_CALL_LIMIT", 1000),
    batchSize: integer("LEAD_ENRICHMENT_BATCH_SIZE", 100, 1),
    maxConcurrentJobs: integer("LEAD_ENRICHMENT_MAX_CONCURRENT_JOBS", 2, 1),
    maxRetryAttempts: integer("LEAD_ENRICHMENT_MAX_RETRY_ATTEMPTS", 3, 0),
    retryBackoffMs: integer("LEAD_ENRICHMENT_RETRY_BACKOFF_MS", 1000, 100),
    minFreeDiskBytes: integer("LEAD_ENRICHMENT_MIN_FREE_DISK_BYTES", 1024 * 1024 * 1024, 0),
    retentionDays: integer("LEAD_ENRICHMENT_RETENTION_DAYS", 30, 1),
    hostId: process.env.LEAD_ENRICHMENT_HOST_ID?.trim() || "local",
    maxUploadBytes: integer("LEAD_ENRICHMENT_MAX_UPLOAD_BYTES", 5 * 1024 * 1024 * 1024, 1),
    finderBaseUrl: process.env.LEAD_FINDER_BASE_URL?.trim() || "",
    finderAuthToken: process.env.LEAD_FINDER_AUTH_TOKEN?.trim() || "",
    llmBaseUrl: process.env.LEAD_LLM_BASE_URL?.trim() || "",
    llmApiKey: process.env.LEAD_LLM_API_KEY?.trim() || "",
    llmModel: process.env.LEAD_LLM_MODEL?.trim() || "gemini-3.5-flash-lite",
    llmEnabled: /^(1|true|yes|on)$/i.test(process.env.LEAD_LLM_ENABLED || "false"),
    llmProvider: (process.env.LEAD_LLM_PROVIDER?.trim().toLowerCase() || "gemini"),
    llmFallbackProvider: (process.env.LEAD_LLM_FALLBACK_PROVIDER?.trim().toLowerCase() || "openai"),
    llmFallbackModel: process.env.LEAD_LLM_FALLBACK_MODEL?.trim() || "gpt-6-luna",
    llmFallbackApiKey: process.env.LEAD_LLM_FALLBACK_API_KEY?.trim() || "",
    llmFallbackBaseUrl: process.env.LEAD_LLM_FALLBACK_BASE_URL?.trim() ||
        "https://api.openai.com/v1",
    llmWebsiteResearchEnabled: /^(1|true|yes|on)$/i.test(process.env.LEAD_LLM_WEBSITE_RESEARCH_ENABLED || "true"),
};
