import type { VerificationStatus } from "./types";
import { randomUUID } from "node:crypto";
import { config } from "./config";

// Normalized verifier result for one candidate address.
export interface BatchResult {
  email: string;
  status: VerificationStatus;
  reason?: string;
  domain?: string;
  fromCache: boolean;
  billable: boolean;
}

// Aggregate response metadata is persisted separately from individual outcomes.
export interface BatchResponse {
  requestId: string;
  provider: string;
  results: BatchResult[];
  providerChecksCount: number;
  cacheHitCount: number;
  billableChecksCount: number;
  cancelled?: boolean;
}

// Sends one bounded, stable request-ID batch to the verifier's local-file-safe
// API. It does not upload the CSV or require S3 manifests.
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
  const batchRequestId = `${requestId}-${randomUUID()}`;
  let cancelPromise: Promise<void> | undefined;
  let requestController: AbortController | undefined;
  let requestTimeout: ReturnType<typeof setTimeout> | undefined;
  const setRequestTimeout = (milliseconds: number): void => {
    if (requestTimeout) clearTimeout(requestTimeout);
    requestTimeout = setTimeout(() => requestController?.abort(), milliseconds);
  };
  const cancelBatch = (): void => {
    if (requestController) setRequestTimeout(180_000);
    cancelPromise = fetch(`${baseUrl.replace(/\/$/, "")}/api/verify-batch/cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({ requestId: batchRequestId }),
      signal: AbortSignal.timeout(5_000),
    }).then((response) => {
      if (!response.ok) throw new Error(`Verifier cancellation failed (HTTP ${response.status})`);
    }).catch((error: unknown) => {
      console.error("[lead-enrichment] verifier cancellation request failed", {
        requestId: batchRequestId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  signal?.addEventListener("abort", cancelBatch, { once: true });
  let lastError: Error | null = null;
  try {
    for (let attempt = 0; attempt <= config.maxRetryAttempts; attempt += 1) {
      if (signal?.aborted) {
        throw new Error("Verification cancellation could not be confirmed; provider checks may still be running");
      }
      try {
        requestController = new AbortController();
        setRequestTimeout(30_000);
        const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/verify-batch`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify({
            requestId: batchRequestId,
            provider,
            emails,
            maxProviderCalls,
            cancellable: true,
          }),
          signal: requestController.signal,
        });
        if (response.status === 429) {
          throw new Error("Verifier batch is rate limited (HTTP 429)");
        }
        if (!response.ok) {
          throw new Error(
            `Verifier batch request failed (HTTP ${response.status})`,
          );
        }
        const result = (await response.json()) as BatchResponse;
        await cancelPromise;
        return result;
      } catch (error) {
        if (signal?.aborted) {
          await cancelPromise;
          throw new Error("Verification cancellation could not be confirmed; provider checks may still be running");
        }
        lastError =
          error instanceof Error
            ? error
            : new Error("Verifier batch request failed");
        if (attempt < config.maxRetryAttempts) {
          await new Promise<void>((resolve) => {
            const finish = (): void => {
              signal?.removeEventListener("abort", onAbort);
              resolve();
            };
            const timeout = setTimeout(finish, config.retryBackoffMs * 2 ** attempt);
            const onAbort = (): void => {
              clearTimeout(timeout);
              finish();
            };
            signal?.addEventListener("abort", onAbort, { once: true });
          });
        }
      } finally {
        if (requestTimeout) clearTimeout(requestTimeout);
        requestTimeout = undefined;
        requestController = undefined;
      }
    }
    throw lastError || new Error("Verifier batch request failed");
  } finally {
    signal?.removeEventListener("abort", cancelBatch);
  }
};
