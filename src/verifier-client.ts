import { setTimeout as delay } from "node:timers/promises";
import type { VerificationStatus } from "./types";

export interface BatchResult {
  email: string;
  status: VerificationStatus;
  reason?: string;
  domain?: string;
  fromCache: boolean;
  billable: boolean;
}

export interface BatchResponse {
  requestId: string;
  provider: string;
  status: "queued" | "processing" | "completed" | "cancelled" | "paused" | "failed";
  results: BatchResult[];
  providerChecksCount: number;
  cacheHitCount: number;
  billableChecksCount: number;
  billingUnknownCount?: number;
  cancelled?: boolean;
  error?: string;
}

export class VerifierOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifierOutcomeUnknownError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isValidResult = (
  value: unknown,
  requestId: string,
  provider: string,
  emails: string[],
): value is BatchResponse => {
  if (!isRecord(value) || value.requestId !== requestId || value.provider !== provider ||
      !["queued", "processing", "completed", "cancelled", "paused", "failed"].includes(String(value.status)) ||
      !Array.isArray(value.results)) return false;
  for (const key of ["providerChecksCount", "cacheHitCount", "billableChecksCount"] as const) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) return false;
  }
  if (Number(value.billableChecksCount) > Number(value.providerChecksCount)) return false;
  if (value.billingUnknownCount !== undefined &&
      (!Number.isSafeInteger(value.billingUnknownCount) || Number(value.billingUnknownCount) < 0)) return false;
  if (Number(value.billingUnknownCount || 0) + Number(value.billableChecksCount) >
      Number(value.providerChecksCount)) return false;
  const expected = new Set(emails.map((email) => email.trim().toLowerCase()));
  const seen = new Set<string>();
  for (const entry of value.results) {
    if (!isRecord(entry) || typeof entry.email !== "string" ||
        !expected.has(entry.email) || seen.has(entry.email) ||
        !["valid", "invalid", "uncertain", "catch_all", "rate_limited", "provider_failed", "not_deep_verified"].includes(String(entry.status)) ||
        typeof entry.fromCache !== "boolean" || typeof entry.billable !== "boolean") return false;
    seen.add(entry.email);
  }
  if (value.status === "completed" && seen.size !== expected.size) return false;
  if (value.results.filter((entry) => entry.billable === true).length !== value.billableChecksCount ||
      value.results.filter((entry) => entry.fromCache === true).length !== value.cacheHitCount) return false;
  return true;
};

export const verifyBatch = async (
  baseUrl: string,
  authToken: string,
  requestId: string,
  provider: string,
  emails: string[],
  maxProviderCalls: number,
  signal?: AbortSignal,
): Promise<BatchResponse> => {
  signal?.throwIfAborted();
  const base = `${baseUrl.replace(/\/$/, "")}/api/batches`;
  const endpoint = `${base}/${encodeURIComponent(requestId)}`;
  const headers = {
    "Content-Type": "application/json",
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
  };
  let submitted = false;
  let cancellationSent = false;
  let connectionFailures = 0;
  for (;;) {
    if (signal?.aborted && !submitted) {
      throw new VerifierOutcomeUnknownError(
        `Submission of batch ${requestId} could not be confirmed; provider checks may still be running`,
      );
    }
    if (signal?.aborted && !cancellationSent) {
      try {
        const response = await fetch(`${endpoint}/cancel`, {
          method: "POST", headers, signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        cancellationSent = true;
      } catch {
        throw new VerifierOutcomeUnknownError(
          `Cancellation of batch ${requestId} could not be confirmed; provider checks may still be running`,
        );
      }
    }
    let response: Response;
    try {
      response = await fetch(submitted ? endpoint : base, {
        method: submitted ? "GET" : "POST",
        headers,
        ...(!submitted ? { body: JSON.stringify({ requestId, provider, emails, maxProviderCalls }) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new VerifierOutcomeUnknownError(
          `Batch ${requestId} could not be reached; provider checks may still be running`,
        );
      }
      connectionFailures += 1;
      if (connectionFailures === 1 || connectionFailures % 30 === 0) {
        console.warn("[lead-enrichment] waiting for verifier batch connection", {
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await delay(1_000);
      continue;
    }
    if (response.status === 409 || response.status === 410 || (submitted && response.status === 404)) {
      throw new VerifierOutcomeUnknownError(
        `Verifier cannot reconcile batch ${requestId} (HTTP ${response.status}); operator review required`,
      );
    }
    if (response.status === 503 && !submitted) {
      try {
        const body: unknown = await response.clone().json();
        if (isRecord(body) && body.code === "PROVIDER_NOT_CONFIGURED" && typeof body.error === "string") {
          throw new Error(body.error);
        }
      } catch (error) {
        if (error instanceof Error && !(error instanceof SyntaxError)) throw error;
      }
    }
    if (response.status >= 500 || response.status === 429) {
      if (signal?.aborted) {
        throw new VerifierOutcomeUnknownError(
          `Batch ${requestId} could not be reconciled (HTTP ${response.status})`,
        );
      }
      connectionFailures += 1;
      if (connectionFailures === 1 || connectionFailures % 30 === 0) {
        console.warn("[lead-enrichment] verifier batch temporarily unavailable", {
          requestId, status: response.status,
        });
      }
      await delay(1_000);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Verifier batch request failed (HTTP ${response.status})`);
    }
    if (!submitted) {
      submitted = true;
      continue;
    }
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new VerifierOutcomeUnknownError(`Verifier response for batch ${requestId} could not be read`);
    }
    if (!isValidResult(result, requestId, provider, emails)) {
      throw new VerifierOutcomeUnknownError(`Verifier returned invalid status for batch ${requestId}`);
    }
    if (result.status === "paused" || result.status === "failed") {
      throw new VerifierOutcomeUnknownError(
        `Batch ${requestId} requires review: ${result.error || result.status}`,
      );
    }
    if (result.status === "completed" || result.status === "cancelled") return result;
    try {
      await delay(1_000, undefined, { signal });
    } catch (error) {
      if (!signal?.aborted) throw error;
    }
  }
};
