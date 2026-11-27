"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runLeadJob = exports.VERIFIER_REVIEW_READY = exports.VERIFIER_REVIEW_REQUIRED = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = require("node:crypto");
const csv_parse_1 = require("csv-parse");
const csv_1 = require("./csv");
const state_1 = require("./state");
const verifier_client_1 = require("./verifier-client");
const suppressions_1 = require("./suppressions");
const domain_cache_1 = require("./domain-cache");
const audit_1 = require("./audit");
const config_1 = require("./config");
const pending_batch_1 = require("./pending-batch");
const provider_adapters_1 = require("./provider-adapters");
const website_research_1 = require("./website-research");
class JobCancelledError extends Error {
    constructor() {
        super("Cancelled by operator");
    }
}
exports.VERIFIER_REVIEW_REQUIRED = "Verifier outcome requires operator review";
exports.VERIFIER_REVIEW_READY = "Verifier batch reviewed; ready to resume";
const outputColumns = [
    "lead_row_id",
    "candidate_email",
    "verification_status",
    "verification_reason",
];
const legacyOutputColumns = [
    ...outputColumns,
    "verification_domain",
    "verification_from_cache",
    "verification_provenance",
];
const matchesCompanyName = (name, company) => {
    const normalize = (value) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const normalizedName = normalize(name.replace(/\s*\(Owner\)$/i, ""));
    return Boolean(normalizedName && normalizedName === normalize(company));
};
const roleWords = new Set([
    "owner", "founder", "ceo", "team", "sales", "support", "admin",
    "info", "contact", "marketing", "office", "service", "services",
]);
const isUsablePersonName = (name, companyName) => {
    const cleaned = name.replace(/\s*\(Owner\)$/i, "").trim();
    if (cleaned.length < 5 || matchesCompanyName(cleaned, companyName))
        return false;
    const words = cleaned.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 5)
        return false;
    if (words.some((word) => roleWords.has(word.replace(/[^a-z]/g, ""))))
        return false;
    if (!/^[a-zA-Z][a-zA-Z.' -]+ [a-zA-Z][a-zA-Z.' -]+$/.test(cleaned))
        return false;
    return true;
};
const applyCachedDomainNames = (lead, domain, discoveredNames, options) => {
    if ((lead.rankedCandidates || []).length > 0)
        return;
    const companyName = options?.companyNameColumn
        ? (0, csv_1.valueFromRow)(lead.source, options.companyNameColumn)
        : "";
    const ownerName = options?.ownerNameColumn
        ? String(lead.source[options.ownerNameColumn] || "").trim()
        : options?.fullNameColumn
            ? String(lead.source[options.fullNameColumn] || "").trim()
            : "";
    const names = [
        ...new Set([
            ...discoveredNames.map((name) => name.replace(/\s*\(Owner\)$/i, "").trim()),
            ownerName && isUsablePersonName(ownerName, companyName)
                ? ownerName.replace(/\s*\(Owner\)$/i, "").trim()
                : "",
        ].filter(Boolean)),
    ];
    if (names.length === 0) {
        lead.verificationStatus = "not_deep_verified";
        lead.verificationReason = "no_name_found";
        return;
    }
    for (const fullName of names) {
        const parts = fullName.trim().split(/\s+/).filter(Boolean);
        if (parts.length < 2)
            continue;
        const aiRecord = {
            ...lead.source,
            __enriched_first_name: parts[0],
            __enriched_last_name: parts.slice(1).join(" "),
            __enriched_domain: domain,
        };
        const ranked = (0, csv_1.rankedCandidateEmails)(aiRecord, undefined, "__enriched_first_name", "__enriched_last_name", "__enriched_domain").map((candidate) => ({
            ...candidate,
            score: Math.max(candidate.score - 5, 20),
            provenance: `ai+${candidate.provenance}`,
        })).slice(0, 2);
        if (ranked.length > 0) {
            lead.rankedCandidates = ranked;
            lead.candidateEmail = ranked[0].email;
            lead.verificationStatus = "not_processed";
            lead.verificationReason = undefined;
            lead.provenance = [...lead.provenance, "ai-discovery"];
            break;
        }
    }
};
// Runs one CSV job end to end. Processing is checkpointed after bounded batches
// so provider counts, progress, and already-written output survive interruptions.
const runLeadJob = async (options) => {
    const excludeMissingEmail = options.initialState
        ? options.initialState.settings?.excludeMissingEmail ?? false
        : options.excludeMissingEmail ?? true;
    options = {
        ...options,
        ...options.initialState?.settings,
        excludeMissingEmail,
        skipUncertainChecks: options.initialState?.settings?.skipUncertainChecks ?? options.skipUncertainChecks ?? false,
    };
    console.info("[lead-enrichment] job processing started", {
        jobId: options.id,
        provider: options.provider,
        batchSize: options.batchSize,
    });
    // Prepare only the host-local directories needed for this run.
    (0, state_1.ensureDir)(node_path_1.default.dirname(options.outputPath));
    (0, state_1.ensureDir)(options.stateDir);
    // A resumed run supplies an existing snapshot. A new run starts a fresh state
    // and starts with no provider usage, processed rows, or checkpoint.
    let state = options.initialState ||
        {
            id: options.id,
            status: "queued",
            inputPath: options.inputPath,
            outputPath: options.outputPath,
            provider: options.provider,
            checkpointRow: 0,
            totalRows: 0,
            processedRows: 0,
            providerChecksCount: 0,
            billableChecksCount: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
    // The first state transition is durable so operators can see that work began.
    state = (0, state_1.saveJobState)(options.stateDir, {
        ...state,
        status: "processing",
        startedAt: options.initialState?.startedAt || new Date().toISOString(),
        currentStage: "reading",
        stageStartedAt: new Date().toISOString(),
        stageUpdatedAt: new Date().toISOString(),
        batchSize: options.batchSize,
        settings: {
            providerCallLimit: options.providerCallLimit,
            batchSize: options.batchSize,
            emailColumn: options.emailColumn,
            firstNameColumn: options.firstNameColumn,
            lastNameColumn: options.lastNameColumn,
            domainColumn: options.domainColumn,
            companyNameColumn: options.companyNameColumn,
            websiteColumn: options.websiteColumn,
            addressColumn: options.addressColumn,
            ownerNameColumn: options.ownerNameColumn,
            fullNameColumn: options.fullNameColumn,
            llmEnabled: options.llmEnabled,
            websiteResearchEnabled: options.websiteResearchEnabled,
            excludeMissingEmail,
        },
    });
    try {
        let sourceRowCount = 0;
        const countInput = node_fs_1.default.createReadStream(options.inputPath);
        const countParser = countInput.pipe((0, csv_parse_1.parse)({
            bom: true,
            columns: true,
            relax_column_count: true,
            skip_empty_lines: true,
        }));
        for await (const _record of countParser) {
            sourceRowCount += 1;
        }
        state.totalRows = sourceRowCount;
        state = (0, state_1.saveJobState)(options.stateDir, state);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not count input rows: ${message}`);
    }
    let pending = (0, pending_batch_1.loadPendingBatch)(options.stateDir, options.id);
    let pendingBatchProcessed = false;
    if (pending && state.checkpointRow >= pending.endRow) {
        (0, pending_batch_1.completePendingBatch)(options.stateDir, pending);
        pending = undefined;
    }
    if (pending) {
        if (pending.startRow !== state.checkpointRow + 1 ||
            !node_fs_1.default.existsSync(options.outputPath) ||
            node_fs_1.default.statSync(options.outputPath).size < pending.outputOffset) {
            throw new Error("Saved enrichment batch and output checkpoint do not match");
        }
        node_fs_1.default.truncateSync(options.outputPath, pending.outputOffset);
        state.tokenCount = pending.tokenCount;
        state.costEstimateUsd = pending.costEstimateUsd;
        if (pending.providerChecksCount !== undefined)
            state.providerChecksCount = pending.providerChecksCount;
        if (pending.billableChecksCount !== undefined)
            state.billableChecksCount = pending.billableChecksCount;
        if (pending.billingUnknownCount !== undefined)
            state.billingUnknownCount = pending.billingUnknownCount;
        if (pending.cacheHitCount !== undefined)
            state.cacheHitCount = pending.cacheHitCount;
    }
    else if (state.checkpointRow === 0) {
        // Start with an empty destination for a new job; resume mode appends later.
        node_fs_1.default.writeFileSync(options.outputPath, "", "utf8");
    }
    // headers comes from the first parsed CSV row. It is used to append the
    // original source values before every enrichment column.
    let headers = [];
    let rowNumber = 0;
    // Once a header is written, subsequent resumed batches must not write it again.
    let headerWritten = node_fs_1.default.statSync(options.outputPath).size > 0;
    let legacyOutput = false;
    // Append mode keeps memory bounded and allows checkpoints to survive restarts.
    const output = node_fs_1.default.createWriteStream(options.outputPath, {
        flags: "a",
    });
    const writeOutput = async (line) => {
        if (output.write(line))
            return;
        await new Promise((resolve, reject) => {
            output.once("drain", resolve);
            output.once("error", reject);
        });
    };
    const flushOutput = async () => {
        await new Promise((resolve, reject) => {
            output.write("", (error) => error ? reject(error) : resolve());
        });
        const fd = node_fs_1.default.openSync(options.outputPath, "r");
        try {
            node_fs_1.default.fsyncSync(fd);
        }
        finally {
            node_fs_1.default.closeSync(fd);
        }
    };
    // This parser streams records from disk instead of loading the complete CSV.
    const input = node_fs_1.default.createReadStream(options.inputPath);
    const parser = input.pipe((0, csv_parse_1.parse)({
        bom: true,
        columns: true,
        relax_column_count: true,
        skip_empty_lines: true,
    }));
    const throwIfCancelled = () => {
        if (options.signal?.aborted || options.cancelRequested?.()) {
            throw new JobCancelledError();
        }
    };
    const emitBatch = async (batch) => {
        state.currentStage = "writing";
        state.stageUpdatedAt = new Date().toISOString();
        state = (0, state_1.saveJobState)(options.stateDir, state);
        if (pending) {
            if (pending.endRow !== rowNumber || pending.rows.length !== batch.length ||
                pending.rows.some((row, index) => row.rowId !== batch[index].rowId)) {
                throw new Error("Input rows do not match the saved enrichment batch");
            }
            batch.splice(0, batch.length, ...pending.rows);
        }
        else if (options.llmEnabled) {
            state.currentStage = "candidates";
            state.stageUpdatedAt = new Date().toISOString();
            state = (0, state_1.saveJobState)(options.stateDir, state);
            const domainLeads = new Map();
            for (const lead of batch) {
                if ((lead.rankedCandidates || []).length > 0)
                    continue;
                const domain = (0, csv_1.normalizeDomain)((options.domainColumn ? String(lead.source[options.domainColumn] || "") : "") ||
                    (options.websiteColumn ? String(lead.source[options.websiteColumn] || "") : ""));
                if (!domain)
                    continue;
                const leads = domainLeads.get(domain) || [];
                leads.push(lead);
                domainLeads.set(domain, leads);
            }
            for (const [domain, leads] of domainLeads) {
                throwIfCancelled();
                state.currentStage = "research";
                state.stageUpdatedAt = new Date().toISOString();
                state = (0, state_1.saveJobState)(options.stateDir, state);
                const cached = (0, domain_cache_1.getDomainCache)(domain);
                if (cached && typeof cached === "object") {
                    const cachedNames = "names" in cached && Array.isArray(cached.names)
                        ? cached.names.filter((name) => typeof name === "string")
                        : [];
                    for (const lead of leads)
                        applyCachedDomainNames(lead, domain, cachedNames, options);
                    continue;
                }
                const companyName = options.companyNameColumn
                    ? (0, csv_1.valueFromRow)(leads[0].source, options.companyNameColumn)
                    : "";
                const research = (options.websiteResearchEnabled ?? true)
                    ? await (0, website_research_1.researchCompanyDomain)(domain, options.signal)
                    : null;
                throwIfCancelled();
                const discovered = await (0, provider_adapters_1.enrichWithLlm)({
                    domain,
                    companyName: companyName || research?.title,
                    sourceUrl: research?.url,
                    sourceText: research?.text,
                }, options.signal);
                const discoveredNames = (discovered?.names || []).filter((name) => isUsablePersonName(name, companyName));
                (0, domain_cache_1.setDomainCache)(domain, { names: discoveredNames, verifiedAt: Date.now() }, 24 * 60 * 60 * 1000);
                if (discovered) {
                    state.tokenCount = (state.tokenCount || 0) + discovered.tokenCount;
                    state.costEstimateUsd = (state.costEstimateUsd || 0) + discovered.costEstimateUsd;
                }
                console.info("[lead-enrichment] AI discovery result", {
                    jobId: options.id,
                    domain,
                    companyName,
                    discoveredNames,
                });
                for (const lead of leads)
                    applyCachedDomainNames(lead, domain, discoveredNames, options);
            }
        }
        throwIfCancelled();
        if (!pending) {
            await flushOutput();
            pending = {
                version: 1,
                jobId: options.id,
                requestId: `${options.id}-${(0, node_crypto_1.randomUUID)()}`,
                startRow: rowNumber - batch.length + 1,
                endRow: rowNumber,
                outputOffset: node_fs_1.default.statSync(options.outputPath).size,
                rows: batch,
                tokenCount: state.tokenCount,
                costEstimateUsd: state.costEstimateUsd,
                providerChecksCount: state.providerChecksCount,
                billableChecksCount: state.billableChecksCount,
                billingUnknownCount: state.billingUnknownCount || 0,
                cacheHitCount: state.cacheHitCount || 0,
            };
            (0, pending_batch_1.savePendingBatch)(options.stateDir, pending);
        }
        // A row with no candidate is retained but explicitly marked not verified.
        // The addresses below, rather than the source rows, determine provider calls.
        // Only candidate addresses consume the verifier/provider budget.
        const candidates = [
            ...new Set(batch.flatMap((lead) => (lead.rankedCandidates || [])
                .map((candidate) => candidate.email)
                .filter((email) => !(0, suppressions_1.isSuppressed)(email)))),
        ];
        if (candidates.length === 0) {
            for (const lead of batch) {
                lead.verificationStatus = "not_deep_verified";
                lead.verificationReason =
                    lead.verificationReason === "no_name_found"
                        ? "no_name_found"
                        : lead.source[options.domainColumn ||
                            options.websiteColumn ||
                            ""]
                            ? "no_candidate_generated"
                            : "no_domain_found";
                lead.verificationDomain = undefined;
            }
        }
        else {
            // Remaining job budget is calculated here so each batch cannot overspend
            // the operator's configured enrichment provider-call limit.
            // The batch response is authoritative for both provider counts and outcomes.
            state.currentStage = "verification";
            state.stageUpdatedAt = new Date().toISOString();
            state.currentBatch =
                (state.currentBatch || 0) + 1;
            state.currentBatchStart = Math.max(rowNumber - batch.length + 1, 1);
            state.currentBatchEnd = rowNumber;
            state = (0, state_1.saveJobState)(options.stateDir, state);
            const providerChecksBase = state.providerChecksCount;
            const billableChecksBase = state.billableChecksCount;
            const billingUnknownBase = state.billingUnknownCount || 0;
            const cacheHitBase = state.cacheHitCount || 0;
            const response = await (0, verifier_client_1.verifyBatch)(options.verifierBaseUrl, options.verifierAuthToken, pending.requestId, options.provider, candidates, Math.max(options.providerCallLimit - state.providerChecksCount, 0), options.signal, options.skipUncertainChecks, (batchStatus) => {
                state.providerChecksCount = providerChecksBase + batchStatus.providerChecksCount;
                state.billableChecksCount = billableChecksBase + batchStatus.billableChecksCount;
                state.billingUnknownCount = billingUnknownBase + (batchStatus.billingUnknownCount || 0);
                state.cacheHitCount = cacheHitBase + batchStatus.cacheHitCount;
                state.currentStage =
                    batchStatus.status === "paused" ? "paused" : "verification";
                state.stageUpdatedAt = new Date().toISOString();
                state = (0, state_1.saveJobState)(options.stateDir, state);
            });
            if (response.status === "completed") {
                pending.verifierCompleted = true;
                (0, pending_batch_1.savePendingBatch)(options.stateDir, pending);
            }
            state.providerChecksCount = providerChecksBase + response.providerChecksCount;
            state.billableChecksCount = billableChecksBase + response.billableChecksCount;
            state.billingUnknownCount =
                billingUnknownBase + (response.billingUnknownCount || 0);
            state.cacheHitCount =
                cacheHitBase + response.cacheHitCount;
            throwIfCancelled();
            // Match verifier responses by candidate address for in-memory batch joining.
            // Keep the verifier result separate from source identity; row linkage is retained
            // by the outer LeadRow record.
            const byEmail = new Map(response.results.map((result) => [result.email, result]));
            for (const lead of batch) {
                const ranked = lead.rankedCandidates || [];
                if (ranked.some((candidate) => (0, suppressions_1.isSuppressed)(candidate.email))) {
                    lead.verificationStatus = "not_deep_verified";
                    lead.verificationReason = "Candidate is suppressed";
                }
                const verified = ranked
                    .map((candidate) => ({
                    candidate,
                    result: byEmail.get(candidate.email),
                }))
                    .filter((entry) => entry.result &&
                    entry.result.status !== "provider_failed" &&
                    entry.result.status !== "rate_limited" &&
                    !(0, suppressions_1.isSuppressed)(entry.candidate.email))
                    .sort((a, b) => b.candidate.score - a.candidate.score);
                const selected = verified[0];
                if (selected?.result) {
                    lead.candidateEmail = selected.candidate.email;
                    lead.verificationStatus = selected.result.status;
                    lead.verificationReason =
                        `${selected.result.reason || "Verified candidate"}; score=${selected.candidate.score}; rank=${selected.candidate.provenance}`;
                    lead.verificationDomain = selected.result.domain;
                    lead.verificationFromCache = selected.result.fromCache;
                    const domain = selected.result.domain ||
                        selected.candidate.email.split("@").at(-1);
                    if (domain)
                        (0, domain_cache_1.setDomainCache)(domain, selected.result);
                }
                else if (!lead.verificationReason) {
                    lead.verificationStatus = "not_deep_verified";
                    lead.verificationReason =
                        "No ranked candidate produced a usable verification result";
                }
            }
        }
        for (const lead of batch) {
            if (excludeMissingEmail && !lead.candidateEmail)
                continue;
            // Preserve source columns and append enrichment fields, never rewriting input.
            // csvEscape makes both original and generated values safe for comma/quote/newline data.
            const line = [
                ...headers.map((header) => lead.source[header] ?? ""),
                lead.rowId,
                lead.candidateEmail || "",
                lead.verificationStatus,
                lead.verificationReason || "",
                ...(legacyOutput
                    ? [
                        lead.verificationDomain || "",
                        String(lead.verificationFromCache ?? false),
                        lead.provenance.join("|"),
                    ]
                    : []),
            ];
            await writeOutput(`${line.map(csv_1.csvEscape).join(",")}\n`);
        }
        pendingBatchProcessed = true;
    };
    try {
        if (headerWritten && state.checkpointRow > 0) {
            const outputHeader = node_fs_1.default.createReadStream(options.outputPath).pipe((0, csv_parse_1.parse)({ bom: true, to: 1 }));
            for await (const record of outputHeader) {
                legacyOutput = legacyOutputColumns.every((column, index) => record[record.length - legacyOutputColumns.length + index] === column);
            }
        }
        // Batch state is held locally instead of the entire file. This limits peak memory
        // while still preserving original row order in the output.
        let batch = [];
        let candidateGeneratedCount = 0;
        let candidateMissingCount = 0;
        // csv-parse streams records instead of loading the entire CSV into memory.
        for await (const record of parser) {
            throwIfCancelled();
            rowNumber += 1;
            // Header discovery happens once, from the first source record.
            if (headers.length === 0) {
                headers = Object.keys(record);
            }
            // New jobs write the combined source/enrichment header before processing rows.
            // Resumed jobs have this flag set already and skip header generation.
            if (!headerWritten) {
                output.write(`${[...headers, ...outputColumns].map(csv_1.csvEscape).join(",")}\n`);
                headerWritten = true;
            }
            if (rowNumber <= state.checkpointRow)
                continue;
            // Candidate discovery stays separate from verification. Only one pattern
            // candidate is selected per row in this first implementation.
            // A supplied email wins; otherwise name/domain patterns are generated.
            let rankedCandidates = (0, csv_1.rankedCandidateEmails)(record, options.emailColumn, options.firstNameColumn, options.lastNameColumn, options.domainColumn, options.fullNameColumn);
            if (rankedCandidates[0]?.provenance !== "source-email") {
                const sourceFirstName = (0, csv_1.valueFromRow)(record, options.firstNameColumn);
                const sourceLastName = (0, csv_1.valueFromRow)(record, options.lastNameColumn);
                const sourceFullName = (0, csv_1.valueFromRow)(record, options.fullNameColumn);
                const fullName = options.fullNameColumn
                    ? (0, csv_1.splitFullName)(sourceFullName)
                    : { firstName: "", lastName: "" };
                const firstName = sourceFirstName || fullName.firstName;
                const lastName = sourceLastName || fullName.lastName;
                const companyName = (0, csv_1.valueFromRow)(record, options.companyNameColumn);
                if (matchesCompanyName(`${firstName} ${lastName}`, companyName) ||
                    (!sourceFirstName && !sourceLastName && matchesCompanyName(sourceFullName, companyName)) ||
                    !isUsablePersonName(`${firstName} ${lastName}`.trim(), companyName)) {
                    rankedCandidates = [];
                }
                rankedCandidates = rankedCandidates.slice(0, 2);
            }
            const suppressed = rankedCandidates.some((candidate) => (0, suppressions_1.isSuppressed)(candidate.email));
            if (rankedCandidates.length > 0)
                candidateGeneratedCount += 1;
            else
                candidateMissingCount += 1;
            batch.push({
                rowId: (0, csv_1.stableRowId)(record, rowNumber),
                source: { ...record },
                candidateEmail: rankedCandidates[0]?.email,
                rankedCandidates,
                verificationStatus: suppressed
                    ? "not_deep_verified"
                    : "not_processed",
                verificationReason: suppressed
                    ? "Candidate is suppressed"
                    : undefined,
                provenance: rankedCandidates.length
                    ? rankedCandidates.map((candidate) => candidate.provenance)
                    : ["source-row"],
            });
            // Flush when the configured batch size is reached. The flush performs
            // verification, output writing, and checkpoint persistence as one unit.
            if (batch.length >= options.batchSize) {
                throwIfCancelled();
                await emitBatch(batch);
                await flushOutput();
                // Checkpoint only after this batch was sent to the verifier and written
                // locally, avoiding duplicate output on restart.
                state.processedRows = rowNumber;
                state.checkpointRow = rowNumber;
                const candidateRows = batch.filter((lead) => (lead.rankedCandidates || []).length > 0).length;
                state.candidateCount =
                    (state.candidateCount || 0) + candidateRows;
                state.candidateMissingCount =
                    (state.candidateMissingCount || 0) +
                        (batch.length - candidateRows);
                state.suppressedCount =
                    (state.suppressedCount || 0) +
                        batch.filter((lead) => lead.rankedCandidates?.some((candidate) => (0, suppressions_1.isSuppressed)(candidate.email))).length;
                batch = [];
                state.currentStage = "checkpoint";
                state.stageUpdatedAt = new Date().toISOString();
                state.lastCheckpointAt = new Date().toISOString();
                state = (0, state_1.saveJobState)(options.stateDir, state);
                if (pending)
                    (0, pending_batch_1.completePendingBatch)(options.stateDir, pending);
                pending = undefined;
                pendingBatchProcessed = false;
                console.info("[lead-enrichment] checkpoint", {
                    jobId: options.id,
                    processedRows: state.processedRows,
                    providerChecksCount: state.providerChecksCount,
                    candidateCount: state.candidateCount,
                    candidateMissingCount: state.candidateMissingCount,
                });
            }
        }
        // A job with fewer rows than batchSize reaches this final partial batch.
        if (batch.length > 0) {
            throwIfCancelled();
            await emitBatch(batch);
            state.processedRows = rowNumber;
            state.checkpointRow = rowNumber;
            const finalCandidateRows = batch.filter((lead) => (lead.rankedCandidates || []).length > 0).length;
            state.candidateCount =
                (state.candidateCount || 0) + finalCandidateRows;
            state.candidateMissingCount =
                (state.candidateMissingCount || 0) +
                    (batch.length - finalCandidateRows);
        }
        if (pending && !pendingBatchProcessed) {
            throw new Error("Input ended before the saved enrichment batch could be recovered");
        }
        // End-of-stream means every source row was processed. Closing the stream
        // waits for any pending writes before the terminal state is saved.
        throwIfCancelled();
        await new Promise((resolve, reject) => {
            output.end(() => resolve());
            output.once("error", reject);
        });
        const outputFd = node_fs_1.default.openSync(options.outputPath, "r");
        try {
            node_fs_1.default.fsyncSync(outputFd);
        }
        finally {
            node_fs_1.default.closeSync(outputFd);
        }
        throwIfCancelled();
        state.totalRows = rowNumber;
        state.status = "completed";
        state.currentStage = "completed";
        state.stageUpdatedAt = new Date().toISOString();
        const completed = (0, state_1.saveJobState)(options.stateDir, state);
        if (pending)
            (0, pending_batch_1.completePendingBatch)(options.stateDir, pending);
        pending = undefined;
        console.info("[lead-enrichment] job completed", {
            jobId: options.id,
            processedRows: state.processedRows,
            providerChecksCount: state.providerChecksCount,
            billableChecksCount: state.billableChecksCount,
            cacheHitCount: state.cacheHitCount || 0,
            candidateCount: state.candidateCount || 0,
            candidateMissingCount: state.candidateMissingCount || 0,
        });
        (0, audit_1.appendAudit)({
            timestamp: new Date().toISOString(),
            hostId: config_1.config.hostId,
            action: "lead_enrichment.job.completed",
            jobId: state.id,
            status: "success",
            metadata: {
                processedRows: state.processedRows,
                providerChecksCount: state.providerChecksCount,
                billableChecksCount: state.billableChecksCount,
                cacheHitCount: state.cacheHitCount || 0,
                candidateCount: state.candidateCount || 0,
                candidateMissingCount: state.candidateMissingCount || 0,
            },
        });
        return completed;
    }
    catch (error) {
        if (error instanceof JobCancelledError ||
            (options.signal?.aborted && error === options.signal.reason)) {
            state.status = "cancelled";
            state.cancelRequested = true;
            state.error = "Cancelled by operator";
            input.destroy();
            parser.destroy();
            if (!output.writableEnded) {
                await new Promise((resolve, reject) => {
                    output.end(() => resolve());
                    output.once("error", reject);
                });
            }
            const cancelled = (0, state_1.saveJobState)(options.stateDir, state);
            (0, audit_1.appendAudit)({
                timestamp: new Date().toISOString(),
                hostId: config_1.config.hostId,
                action: "lead_enrichment.job.cancelled",
                jobId: state.id,
                status: "success",
            });
            return cancelled;
        }
        // Provider, parser, filesystem, or output failures leave a terminal snapshot
        // so operators can see the cause without losing already-written lead rows.
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof verifier_client_1.VerifierOutcomeUnknownError) {
            state.status = "paused";
            state.currentStage = "paused";
            state.pausedReason = exports.VERIFIER_REVIEW_REQUIRED;
            state.pausedAt = new Date().toISOString();
        }
        else if (/429|rate.?limit/i.test(message)) {
            state.status = "paused";
            state.currentStage = "paused";
            state.pausedReason = "Verifier provider quota or rate limit reached";
            state.pausedAt = new Date().toISOString();
        }
        else {
            state.status = "failed";
        }
        state.retryCount =
            (state.retryCount || 0) + 1;
        state.error = message;
        console.error("[lead-enrichment] job failed", {
            jobId: options.id,
            status: state.status,
            error: message,
        });
        input.destroy();
        if (error instanceof verifier_client_1.VerifierOutcomeUnknownError && !output.writableEnded) {
            try {
                await new Promise((resolve, reject) => {
                    output.once("error", reject);
                    output.end(resolve);
                });
            }
            catch (outputError) {
                state.error += `; output close failed: ${outputError instanceof Error ? outputError.message : String(outputError)}`;
            }
        }
        else {
            output.destroy();
        }
        const terminal = (0, state_1.saveJobState)(options.stateDir, state);
        (0, audit_1.appendAudit)({
            timestamp: new Date().toISOString(),
            hostId: config_1.config.hostId,
            action: state.status === "paused"
                ? "lead_enrichment.job.paused"
                : "lead_enrichment.job.failed",
            jobId: state.id,
            status: "failure",
            metadata: { error: message },
        });
        return terminal;
    }
};
exports.runLeadJob = runLeadJob;
