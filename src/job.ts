import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse";
import {
  csvEscape,
  rankedCandidateEmails,
  stableRowId,
} from "./csv";
import { ensureDir, saveJobState } from "./state";
import { verifyBatch } from "./verifier-client";
import type { LeadJobState, LeadRow, VerificationStatus } from "./types";
import { isSuppressed } from "./suppressions";
import { setDomainCache } from "./domain-cache";
import { appendAudit } from "./audit";
import { config } from "./config";

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
  initialState?: LeadJobState;
  cancelRequested?: () => boolean;
}

const outputColumns = [
  "lead_row_id",
  "candidate_email",
  "verification_status",
  "verification_reason",
  "verification_domain",
  "verification_from_cache",
  "verification_provenance",
];

// Runs one CSV job end to end. Processing is checkpointed after bounded batches
// so provider counts, progress, and already-written output survive interruptions.
export const runLeadJob = async (
  options: StartLeadJobOptions,
): Promise<LeadJobState> => {
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
  });

  if (state.checkpointRow === 0) {
    // Start with an empty destination for a new job; resume mode appends later.
    fs.writeFileSync(options.outputPath, "", "utf8");
  }

  // headers comes from the first parsed CSV row. It is used to append the
  // original source values before every enrichment column.
  let headers: string[] = [];
  let rowNumber = 0;
  // Once a header is written, subsequent resumed batches must not write it again.
  let headerWritten = fs.statSync(options.outputPath).size > 0;
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

  // This parser streams records from disk instead of loading the complete CSV.
  const parser = fs
    .createReadStream(options.inputPath)
    .pipe(
      parse({
        bom: true,
        columns: true,
        relax_column_count: true,
        skip_empty_lines: true,
      }),
    );

  const emitBatch = async (
    batch: LeadRow[],
  ): Promise<void> => {
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
        options.id,
        options.provider,
        candidates,
        Math.max(
          options.providerCallLimit - state.providerChecksCount,
          0,
        ),
      );
      state.providerChecksCount += response.providerChecksCount;
      state.billableChecksCount += response.billableChecksCount;
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
          lead.source.verification_from_cache =
            String(selected.result.fromCache);
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
      // Preserve source columns and append enrichment fields, never rewriting input.
      // csvEscape makes both original and generated values safe for comma/quote/newline data.
      const line = [
        ...headers.map((header) => lead.source[header] ?? ""),
        lead.rowId,
        lead.candidateEmail || "",
        lead.verificationStatus,
        lead.verificationReason || "",
        lead.verificationDomain || "",
        lead.source.verification_from_cache || "false",
        lead.provenance.join("|"),
      ];
      await writeOutput(`${line.map(csvEscape).join(",")}\n`);
    }
  };

  try {
    // Batch state is held locally instead of the entire file. This limits peak memory
    // while still preserving original row order in the output.
    let batch: LeadRow[] = [];
    // csv-parse streams records instead of loading the entire CSV into memory.
    for await (const record of parser as AsyncIterable<Record<string, string>>) {
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
      const rankedCandidates = rankedCandidateEmails(
        record,
        options.emailColumn,
        options.firstNameColumn,
        options.lastNameColumn,
        options.domainColumn,
      );
      const suppressed = rankedCandidates.some((candidate) =>
        isSuppressed(candidate.email),
      );
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
        if (options.cancelRequested?.()) {
          state.status = "cancelled";
          state.error = "Cancelled by operator";
          await new Promise<void>((resolve) => {
            output.end(() => resolve());
          });
          return saveJobState(options.stateDir, state);
        }
        await emitBatch(batch);
        batch = [];
        // Checkpoint only after this batch was sent to the verifier and written
        // locally, avoiding duplicate output on restart.
        state.processedRows = rowNumber;
        state.checkpointRow = rowNumber;
        state.totalRows = rowNumber;
        state = saveJobState(options.stateDir, state);
      }
    }

    // A job with fewer rows than batchSize reaches this final partial batch.
    if (batch.length > 0) {
      if (options.cancelRequested?.()) {
        state.status = "cancelled";
        state.error = "Cancelled by operator";
        await new Promise<void>((resolve) => {
          output.end(() => resolve());
        });
        return saveJobState(options.stateDir, state);
      }
      await emitBatch(batch);
      state.processedRows = rowNumber;
      state.checkpointRow = rowNumber;
    }
    // End-of-stream means every source row was processed. Closing the stream
    // waits for any pending writes before the terminal state is saved.
    state.totalRows = rowNumber;
    state.status = "completed";
    await new Promise<void>((resolve, reject) => {
      output.end(() => resolve());
      output.once("error", reject);
    });
    const completed = saveJobState(options.stateDir, state);
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
      },
    });
    return completed;
  } catch (error) {
    // Provider, parser, filesystem, or output failures leave a terminal snapshot
    // so operators can see the cause without losing already-written lead rows.
    const message =
      error instanceof Error ? error.message : String(error);
    if (/429|rate.?limit/i.test(message)) {
      state.status = "paused";
      state.pausedReason = "Verifier provider quota or rate limit reached";
      state.pausedAt = new Date().toISOString();
    } else {
      state.status = "failed";
    }
    state.retryCount =
      (state.retryCount || 0) + 1;
    state.error = message;
    output.destroy();
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
