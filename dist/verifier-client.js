"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyBatch = void 0;
const node_crypto_1 = require("node:crypto");
const config_1 = require("./config");
// Sends one bounded, stable request-ID batch to the verifier's local-file-safe
// API. It does not upload the CSV or require S3 manifests.
const verifyBatch = async (baseUrl, authToken, requestId, provider, emails, maxProviderCalls, signal) => {
    signal?.throwIfAborted();
    const batchRequestId = `${requestId}-${(0, node_crypto_1.randomUUID)()}`;
    let cancelPromise;
    let requestController;
    let requestTimeout;
    const setRequestTimeout = (milliseconds) => {
        if (requestTimeout)
            clearTimeout(requestTimeout);
        requestTimeout = setTimeout(() => requestController?.abort(), milliseconds);
    };
    const cancelBatch = () => {
        if (requestController)
            setRequestTimeout(180_000);
        cancelPromise = fetch(`${baseUrl.replace(/\/$/, "")}/api/verify-batch/cancel`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            },
            body: JSON.stringify({ requestId: batchRequestId }),
            signal: AbortSignal.timeout(5_000),
        }).then((response) => {
            if (!response.ok)
                throw new Error(`Verifier cancellation failed (HTTP ${response.status})`);
        }).catch((error) => {
            console.error("[lead-enrichment] verifier cancellation request failed", {
                requestId: batchRequestId,
                error: error instanceof Error ? error.message : String(error),
            });
        });
    };
    signal?.addEventListener("abort", cancelBatch, { once: true });
    let lastError = null;
    try {
        for (let attempt = 0; attempt <= config_1.config.maxRetryAttempts; attempt += 1) {
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
                    throw new Error(`Verifier batch request failed (HTTP ${response.status})`);
                }
                const result = (await response.json());
                await cancelPromise;
                return result;
            }
            catch (error) {
                if (signal?.aborted) {
                    await cancelPromise;
                    throw new Error("Verification cancellation could not be confirmed; provider checks may still be running");
                }
                lastError =
                    error instanceof Error
                        ? error
                        : new Error("Verifier batch request failed");
                if (attempt < config_1.config.maxRetryAttempts) {
                    await new Promise((resolve) => {
                        const finish = () => {
                            signal?.removeEventListener("abort", onAbort);
                            resolve();
                        };
                        const timeout = setTimeout(finish, config_1.config.retryBackoffMs * 2 ** attempt);
                        const onAbort = () => {
                            clearTimeout(timeout);
                            finish();
                        };
                        signal?.addEventListener("abort", onAbort, { once: true });
                    });
                }
            }
            finally {
                if (requestTimeout)
                    clearTimeout(requestTimeout);
                requestTimeout = undefined;
                requestController = undefined;
            }
        }
        throw lastError || new Error("Verifier batch request failed");
    }
    finally {
        signal?.removeEventListener("abort", cancelBatch);
    }
};
exports.verifyBatch = verifyBatch;
