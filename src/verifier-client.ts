import type { VerificationStatus } from "./types";
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
): Promise<BatchResponse> => {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= config.maxRetryAttempts; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/verify-batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          requestId,
          provider,
          emails,
          maxProviderCalls,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 429) {
        throw new Error("Verifier batch is rate limited (HTTP 429)");
      }
      if (!response.ok) {
        throw new Error(
          `Verifier batch request failed (HTTP ${response.status})`,
        );
      }
      return (await response.json()) as BatchResponse;
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new Error("Verifier batch request failed");
      if (attempt < config.maxRetryAttempts) {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            config.retryBackoffMs * 2 ** attempt,
          ),
        );
      }
    }
  }
  throw lastError || new Error("Verifier batch request failed");
};
