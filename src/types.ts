export type VerificationStatus =
  | "valid"
  | "invalid"
  | "uncertain"
  | "catch_all"
  | "rate_limited"
  | "provider_failed"
  | "not_deep_verified";

export interface LeadJobSettings {
  providerCallLimit: number;
  batchSize: number;
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
  skipUncertainChecks?: boolean;
  excludeMissingEmail: boolean;
}

// Persisted lifecycle state is deliberately local and provider-neutral.
// It is safe to expose to the admin UI without including lead email addresses.
export interface LeadJobState {
  id: string;
  status: "queued" | "processing" | "paused" | "completed" | "failed" | "cancelled";
  inputPath: string;
  outputPath: string;
  provider: string;
  checkpointRow: number;
  totalRows: number;
  processedRows: number;
  providerChecksCount: number;
  billableChecksCount: number;
  billingUnknownCount?: number;
  settings?: LeadJobSettings;
  cacheHitCount?: number;
  retryCount?: number;
  pausedReason?: string;
  pausedAt?: string;
  costEstimateUsd?: number;
  tokenCount?: number;
  candidateCount?: number;
  candidateMissingCount?: number;
  suppressedCount?: number;
  cancelRequested?: boolean;
  inputDeleted?: boolean;
  outputDeleted?: boolean;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

// One source CSV row plus its candidate and normalized verification outcome.
export interface LeadRow {
  rowId: string;
  source: Record<string, string>;
  candidateEmail?: string;
  rankedCandidates?: Array<{
    email: string;
    score: number;
    provenance: string;
  }>;
  verificationStatus: VerificationStatus | "not_processed";
  verificationReason?: string;
  verificationDomain?: string;
  verificationFromCache?: boolean;
  provenance: string[];
}
