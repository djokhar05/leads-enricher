import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "csv-parse";
import {
  csvEscape,
  normalizeDomain,
  rankedCandidateEmails,
  splitFullName,
  stableRowId,
  valueFromRow,
} from "./csv";
import { ensureDir, saveJobState } from "./state";
import { verifyBatch, VerifierOutcomeUnknownError } from "./verifier-client";
import type { LeadJobState, LeadRow, VerificationStatus } from "./types";
import { isSuppressed } from "./suppressions";
import { setDomainCache } from "./domain-cache";
import { appendAudit } from "./audit";
import { config } from "./config";
import { completePendingBatch, loadPendingBatch, savePendingBatch } from "./pending-batch";
import { enrichWithLlm } from "./provider-adapters";
import {
  researchCompanyDomain,
} from "./website-research";

// Configuration for a single local CSV enrichment run.
export interface StartLeadJobOptions {
  id: string;
  inputPath: string;
  outputPath: string;
  stateDir: string;
  provider: string;
  providerCallLimit: number;
  batchSize: number;
  verifierBaseUrl: string;
  verifierAuthToken: string;
  emailColumn?: string;
  firstNameColumn?: string;
  lastNameColumn?: string;
  domainColumn?: string;
  companyNameColumn?: string;
  websiteColumn?: string;
  addressColumn?: string;
  ownerNameColumn?: string;
  fullNameColumn?: string;
  llmEnabled?: boolean;
  websiteResearchEnabled?: boolean;
  excludeMissingEmail?: boolean;
  skipUncertainChecks?: boolean;
  initialState?: LeadJobState;
  cancelRequested?: () => boolean;
  signal?: AbortSignal;
}

class JobCancelledError extends Error {
  constructor() {
    super("Cancelled by operator");
  }
}

export const VERIFIER_REVIEW_REQUIRED = "Verifier outcome requires operator review";
export const VERIFIER_REVIEW_READY = "Verifier batch reviewed; ready to resume";

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

const matchesCompanyName = (name: string, company: string): boolean => {
  const normalize = (value: string): string =>
    value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const normalizedName = normalize(name.replace(/\s*\(Owner\)$/i, ""));
  return Boolean(normalizedName && normalizedName === normalize(company));
};

// Runs one CSV job end to end. Processing is checkpointed after bounded batches
// so provider counts, progress, and already-written output survive interruptions.
export const runLeadJob = async (
  options: StartLeadJobOptions,
): Promise<LeadJobState> => {
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
  ensureDir(path.dirname(options.outputPath));
  ensureDir(options.stateDir);

  // A resumed run supplies an existing snapshot. A new run starts a fresh state
  // and starts with no provider usage, processed rows, or checkpoint.
  let state =
    options.initialState ||
    ({
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
    } satisfies LeadJobState);

  // The first state transition is durable so operators can see that work began.
  state = saveJobState(options.stateDir, {
    ...state,
    status: "processing",
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

  let pending = loadPendingBatch(options.stateDir, options.id);
  let pendingBatchProcessed = false;
  if (pending && state.checkpointRow >= pending.endRow) {
    completePendingBatch(options.stateDir, pending);
    pending = undefined;
  }
  if (pending) {
    if (pending.startRow !== state.checkpointRow + 1 ||
        !fs.existsSync(options.outputPath) ||
        fs.statSync(options.outputPath).size < pending.outputOffset) {
      throw new Error("Saved enrichment batch and output checkpoint do not match");
    }
    fs.truncateSync(options.outputPath, pending.outputOffset);
    state.tokenCount = pending.tokenCount;
    state.costEstimateUsd = pending.costEstimateUsd;
    if (pending.providerChecksCount !== undefined) state.providerChecksCount = pending.providerChecksCount;
    if (pending.billableChecksCount !== undefined) state.billableChecksCount = pending.billableChecksCount;
    if (pending.billingUnknownCount !== undefined) state.billingUnknownCount = pending.billingUnknownCount;
    if (pending.cacheHitCount !== undefined) state.cacheHitCount = pending.cacheHitCount;
  } else if (state.checkpointRow === 0) {
    // Start with an empty destination for a new job; resume mode appends later.
    fs.writeFileSync(options.outputPath, "", "utf8");
  }

  // headers comes from the first parsed CSV row. It is used to append the
  // original source values before every enrichment column.
  let headers: string[] = [];
  let rowNumber = 0;
  // Once a header is written, subsequent resumed batches must not write it again.
  let headerWritten = fs.statSync(options.outputPath).size > 0;
  let legacyOutput = false;
  // Append mode keeps memory bounded and allows checkpoints to survive restarts.
  const output = fs.createWriteStream(options.outputPath, {
    flags: "a",
  });

  const writeOutput = async (line: string): Promise<void> => {
    if (output.write(line)) return;
    await new Promise<void>((resolve, reject) => {
      output.once("drain", resolve);
      output.once("error", reject);
    });
  };

  const flushOutput = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      output.write("", (error) => error ? reject(error) : resolve());
    });
    const fd = fs.openSync(options.outputPath, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };

  // This parser streams records from disk instead of loading the complete CSV.
  const input = fs.createReadStream(options.inputPath);
  const parser = input.pipe(
    parse({
      bom: true,
      columns: true,
      relax_column_count: true,
      skip_empty_lines: true,
    }),
  );

  const throwIfCancelled = (): void => {
    if (options.signal?.aborted || options.cancelRequested?.()) {
      throw new JobCancelledError();
    }
  };

  const emitBatch = async (
    batch: LeadRow[],
  ): Promise<void> => {
    if (pending) {
      if (pending.endRow !== rowNumber || pending.rows.length !== batch.length ||
          pending.rows.some((row, index) => row.rowId !== batch[index].rowId)) {
        throw new Error("Input rows do not match the saved enrichment batch");
      }
      batch.splice(0, batch.length, ...pending.rows);
    } else if (options.llmEnabled) {
      for (const lead of batch) {
        throwIfCancelled();
        if ((lead.rankedCandidates || []).length > 0) continue;
        const domain =
          normalizeDomain(
            (options.domainColumn
              ? String(lead.source[options.domainColumn] || "")
              : "") ||
              (options.websiteColumn
                ? String(lead.source[options.websiteColumn] || "")
                : ""),
          );
        if (!domain) continue;
        const research =
          (options.websiteResearchEnabled ?? true)
            ? await researchCompanyDomain(domain, options.signal)
            : null;
        throwIfCancelled();
        const companyName = options.companyNameColumn
          ? valueFromRow(lead.source, options.companyNameColumn)
          : "";
        const discovered = await enrichWithLlm({
          domain,
          companyName: companyName || research?.title,
          sourceUrl: research?.url,
          sourceText: research?.text,
        }, options.signal);
        let effectiveDiscovery = discovered;
        let effectiveResearch = research;
        let aiTokenCount = discovered?.tokenCount || 0;
        let aiCostEstimateUsd = discovered?.costEstimateUsd || 0;
        if (!effectiveDiscovery?.names.length) {
          // Search engine fallback skipped — Google/Bing/DuckDuckGo block scrapers
          // and rarely return useful text, wasting tokens without improving hit rate.
        }
        if (!effectiveDiscovery) continue;
        state.tokenCount =
          (state.tokenCount || 0) + aiTokenCount;
        state.costEstimateUsd =
          (state.costEstimateUsd || 0) +
          aiCostEstimateUsd;
        throwIfCancelled();
        console.info("[lead-enrichment] AI discovery result", {
          jobId: options.id,
          domain,
          companyName: lead.source[options.companyNameColumn || ""] || "",
          discoveredNames: effectiveDiscovery.names,
        });
        const ownerName = options.ownerNameColumn
          ? String(lead.source[options.ownerNameColumn] || "").trim()
          : options.fullNameColumn
            ? String(lead.source[options.fullNameColumn] || "").trim()
            : "";
        const fallbackOwnerName =
          ownerName && ownerName.length >= 3
            ? ownerName.replace(/\s*\(Owner\)$/i, "").trim()
            : "";
        const discoverableNames = [
          ...new Set([
            ...effectiveDiscovery.names,
            fallbackOwnerName,
          ].filter((name) => name && !matchesCompanyName(name, companyName))),
        ];
        for (const fullName of discoverableNames) {
          const parts = fullName
            .trim()
            .split(/\s+/)
            .filter(Boolean);
          if (parts.length < 2) continue;
          const firstName = parts[0];
          const lastName = parts.slice(1).join(" ");
          const aiRecord = {
            ...lead.source,
            __enriched_first_name: firstName,
            __enriched_last_name: lastName,
            __enriched_domain: domain,
          };
          const ranked = rankedCandidateEmails(
            aiRecord,
            undefined,
            "__enriched_first_name",
            "__enriched_last_name",
            "__enriched_domain",
          ).map((candidate) =>
            candidate.provenance.startsWith("candidate-pattern")
              ? {
                  ...candidate,
                  score: Math.max(candidate.score - 5, 20),
                  provenance: `ai+${candidate.provenance}`,
                }
              : candidate,
          );
          if (ranked.length > 0) {
            lead.rankedCandidates = ranked;
            lead.candidateEmail = ranked[0].email;
            console.info("[lead-enrichment] AI candidate generated", {
              jobId: options.id,
              rowId: lead.rowId,
              discoveredName: fullName,
              candidateEmail: ranked[0].email,
              domain,
            });
            lead.provenance = [
              ...lead.provenance,
              effectiveResearch
                ? `llm:${effectiveResearch.url}`
                : "llm:explicit-source",
            ];
            break;
          }
        }
      }
    }
    throwIfCancelled();
    if (!pending) {
      await flushOutput();
      pending = {
        version: 1,
        jobId: options.id,
        requestId: `${options.id}-${randomUUID()}`,
        startRow: rowNumber - batch.length + 1,
        endRow: rowNumber,
        outputOffset: fs.statSync(options.outputPath).size,
        rows: batch,
        tokenCount: state.tokenCount,
        costEstimateUsd: state.costEstimateUsd,
        providerChecksCount: state.providerChecksCount,
        billableChecksCount: state.billableChecksCount,
        billingUnknownCount: state.billingUnknownCount || 0,
        cacheHitCount: state.cacheHitCount || 0,
      };
      savePendingBatch(options.stateDir, pending);
    }
    // A row with no candidate is retained but explicitly marked not verified.
    // The addresses below, rather than the source rows, determine provider calls.
    // Only candidate addresses consume the verifier/provider budget.
    const candidates = [
      ...new Set(
        batch.flatMap((lead) =>
          (lead.rankedCandidates || [])
            .map((candidate) => candidate.email)
            .filter((email) => !isSuppressed(email)),
        ),
      ),
    ];
    if (candidates.length === 0) {
      for (const lead of batch) {
        lead.verificationStatus = "not_deep_verified";
        lead.verificationReason = "No candidate email could be generated";
        lead.verificationDomain = undefined;
      }
    } else {
      // Remaining job budget is calculated here so each batch cannot overspend
      // the operator's configured enrichment provider-call limit.
      // The batch response is authoritative for both provider counts and outcomes.
      const response = await verifyBatch(
        options.verifierBaseUrl,
        options.verifierAuthToken,
        pending.requestId,
        options.provider,
        candidates,
        Math.max(
          options.providerCallLimit - state.providerChecksCount,
          0,
        ),
        options.signal,
          options.skipUncertainChecks,
      );
      if (response.status === "completed") {
        pending.verifierCompleted = true;
        savePendingBatch(options.stateDir, pending);
      }
      state.providerChecksCount += response.providerChecksCount;
      state.billableChecksCount += response.billableChecksCount;
      state.billingUnknownCount =
        (state.billingUnknownCount || 0) + (response.billingUnknownCount || 0);
      state.cacheHitCount =
        (state.cacheHitCount || 0) + response.cacheHitCount;
      throwIfCancelled();
      // Match verifier responses by candidate address for in-memory batch joining.
      // Keep the verifier result separate from source identity; row linkage is retained
      // by the outer LeadRow record.
      const byEmail = new Map(
        response.results.map((result) => [result.email, result]),
      );
      for (const lead of batch) {
        const ranked = lead.rankedCandidates || [];
        if (ranked.some((candidate) => isSuppressed(candidate.email))) {
          lead.verificationStatus = "not_deep_verified";
          lead.verificationReason = "Candidate is suppressed";
        }
        const verified = ranked
          .map((candidate) => ({
            candidate,
            result: byEmail.get(candidate.email),
          }))
          .filter((entry) =>
            entry.result &&
            entry.result.status !== "provider_failed" &&
            entry.result.status !== "rate_limited" &&
            !isSuppressed(entry.candidate.email),
          )
          .sort((a, b) =>
            b.candidate.score - a.candidate.score,
          );
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
          if (domain) setDomainCache(domain, selected.result);
        } else if (!lead.verificationReason) {
          lead.verificationStatus = "not_deep_verified";
          lead.verificationReason =
            "No ranked candidate produced a usable verification result";
        }
      }
    }

    for (const lead of batch) {
      if (excludeMissingEmail && !lead.candidateEmail) continue;
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
      await writeOutput(`${line.map(csvEscape).join(",")}\n`);
    }
    pendingBatchProcessed = true;
  };

  try {
    if (headerWritten && state.checkpointRow > 0) {
      const outputHeader = fs.createReadStream(options.outputPath).pipe(
        parse({ bom: true, to: 1 }),
      );
      for await (const record of outputHeader as AsyncIterable<string[]>) {
        legacyOutput = legacyOutputColumns.every(
          (column, index) =>
            record[record.length - legacyOutputColumns.length + index] === column,
        );
      }
    }

    // Batch state is held locally instead of the entire file. This limits peak memory
    // while still preserving original row order in the output.
    let batch: LeadRow[] = [];
    let candidateGeneratedCount = 0;
    let candidateMissingCount = 0;
    // csv-parse streams records instead of loading the entire CSV into memory.
    for await (const record of parser as AsyncIterable<Record<string, string>>) {
      throwIfCancelled();
      rowNumber += 1;
      // Header discovery happens once, from the first source record.
      if (headers.length === 0) {
        headers = Object.keys(record);
      }
      // New jobs write the combined source/enrichment header before processing rows.
      // Resumed jobs have this flag set already and skip header generation.
      if (!headerWritten) {
        output.write(
          `${[...headers, ...outputColumns].map(csvEscape).join(",")}\n`,
        );
        headerWritten = true;
      }
      if (rowNumber <= state.checkpointRow) continue;

      // Candidate discovery stays separate from verification. Only one pattern
      // candidate is selected per row in this first implementation.
      // A supplied email wins; otherwise name/domain patterns are generated.
      let rankedCandidates = rankedCandidateEmails(
        record,
        options.emailColumn,
        options.firstNameColumn,
        options.lastNameColumn,
        options.domainColumn,
        options.fullNameColumn,
      );
      if (rankedCandidates[0]?.provenance !== "source-email") {
        const sourceFirstName = valueFromRow(record, options.firstNameColumn);
        const sourceLastName = valueFromRow(record, options.lastNameColumn);
        const sourceFullName = valueFromRow(record, options.fullNameColumn);
        const fullName = options.fullNameColumn
          ? splitFullName(sourceFullName)
          : { firstName: "", lastName: "" };
        const firstName = sourceFirstName || fullName.firstName;
        const lastName = sourceLastName || fullName.lastName;
        const companyName = valueFromRow(record, options.companyNameColumn);
        if (
          matchesCompanyName(`${firstName} ${lastName}`, companyName) ||
          (!sourceFirstName && !sourceLastName && matchesCompanyName(sourceFullName, companyName))
        ) {
          rankedCandidates = [];
        }
      }
      const suppressed = rankedCandidates.some((candidate) =>
        isSuppressed(candidate.email),
      );
      if (rankedCandidates.length > 0) candidateGeneratedCount += 1;
      else candidateMissingCount += 1;
      batch.push({
        rowId: stableRowId(record, rowNumber),
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
        state.totalRows = rowNumber;
        const candidateRows = batch.filter(
          (lead) => (lead.rankedCandidates || []).length > 0,
        ).length;
        state.candidateCount =
          (state.candidateCount || 0) + candidateRows;
        state.candidateMissingCount =
          (state.candidateMissingCount || 0) +
          (batch.length - candidateRows);
        state.suppressedCount =
          (state.suppressedCount || 0) +
          batch.filter((lead) =>
            lead.rankedCandidates?.some((candidate) =>
              isSuppressed(candidate.email),
            ),
          ).length;
        batch = [];
        state = saveJobState(options.stateDir, state);
        if (pending) completePendingBatch(options.stateDir, pending);
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
      const finalCandidateRows = batch.filter(
        (lead) => (lead.rankedCandidates || []).length > 0,
      ).length;
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
    await new Promise<void>((resolve, reject) => {
      output.end(() => resolve());
      output.once("error", reject);
    });
    const outputFd = fs.openSync(options.outputPath, "r");
    try {
      fs.fsyncSync(outputFd);
    } finally {
      fs.closeSync(outputFd);
    }
    throwIfCancelled();
    state.totalRows = rowNumber;
    state.status = "completed";
    const completed = saveJobState(options.stateDir, state);
    if (pending) completePendingBatch(options.stateDir, pending);
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
    appendAudit({
      timestamp: new Date().toISOString(),
      hostId: config.hostId,
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
  } catch (error) {
    if (
      error instanceof JobCancelledError ||
      (options.signal?.aborted && error === options.signal.reason)
    ) {
      state.status = "cancelled";
      state.cancelRequested = true;
      state.error = "Cancelled by operator";
      input.destroy();
      parser.destroy();
      if (!output.writableEnded) {
        await new Promise<void>((resolve, reject) => {
          output.end(() => resolve());
          output.once("error", reject);
        });
      }
      const cancelled = saveJobState(options.stateDir, state);
      appendAudit({
        timestamp: new Date().toISOString(),
        hostId: config.hostId,
        action: "lead_enrichment.job.cancelled",
        jobId: state.id,
        status: "success",
      });
      return cancelled;
    }
    // Provider, parser, filesystem, or output failures leave a terminal snapshot
    // so operators can see the cause without losing already-written lead rows.
    const message =
      error instanceof Error ? error.message : String(error);
    if (error instanceof VerifierOutcomeUnknownError) {
      state.status = "paused";
      state.pausedReason = VERIFIER_REVIEW_REQUIRED;
      state.pausedAt = new Date().toISOString();
    } else if (/429|rate.?limit/i.test(message)) {
      state.status = "paused";
      state.pausedReason = "Verifier provider quota or rate limit reached";
      state.pausedAt = new Date().toISOString();
    } else {
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
    if (error instanceof VerifierOutcomeUnknownError && !output.writableEnded) {
      try {
        await new Promise<void>((resolve, reject) => {
          output.once("error", reject);
          output.end(resolve);
        });
      } catch (outputError) {
        state.error += `; output close failed: ${outputError instanceof Error ? outputError.message : String(outputError)}`;
      }
    } else {
      output.destroy();
    }
    const terminal = saveJobState(options.stateDir, state);
    appendAudit({
      timestamp: new Date().toISOString(),
      hostId: config.hostId,
      action:
        state.status === "paused"
          ? "lead_enrichment.job.paused"
          : "lead_enrichment.job.failed",
      jobId: state.id,
      status: "failure",
      metadata: { error: message },
    });
    return terminal;
  }
};
