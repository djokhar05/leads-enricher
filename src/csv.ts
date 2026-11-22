import { createHash } from "node:crypto";

export interface RankedCandidate {
  email: string;
  score: number;
  provenance: string;
}

// Reads a selected source column without guessing column names.
export const valueFromRow = (
  row: Record<string, string>,
  columnName?: string,
): string => {
  if (!columnName) return "";
  return String(row[columnName] || "").trim();
};

// The row ID includes the row position and source values so it remains stable
// when downstream systems preserve or re-import the same input row.
export const stableRowId = (
  row: Record<string, string>,
  rowNumber: number,
): string =>
  createHash("sha256")
    .update(JSON.stringify({ rowNumber, row }))
    .digest("hex")
    .slice(0, 20);

export const candidateEmails = (
  row: Record<string, string>,
  emailColumn?: string,
  firstNameColumn?: string,
  lastNameColumn?: string,
  domainColumn?: string,
): string[] => {
  const existing = valueFromRow(row, emailColumn);
  // A supplied address is authoritative; do not generate alternatives for it.
  if (existing) return [existing.toLowerCase()];

  const first = valueFromRow(row, firstNameColumn).toLowerCase();
  const last = valueFromRow(row, lastNameColumn).toLowerCase();
  const domain = valueFromRow(row, domainColumn).toLowerCase();
  if (!first || !last || !domain) return [];

  const normalizedFirst = first.replace(/[^a-z0-9]/g, "");
  const normalizedLast = last.replace(/[^a-z0-9]/g, "");
  if (!normalizedFirst || !normalizedLast) return [];

  // Pattern generation is deliberately simple and provenance is recorded by the
  // caller. These values are candidates, not confirmed identities or mailboxes.
  return [...new Set([
    `${normalizedFirst}.${normalizedLast}@${domain}`,
    `${normalizedFirst}_${normalizedLast}@${domain}`,
    `${normalizedFirst}@${domain}`,
    `${normalizedFirst[0]}${normalizedLast}@${domain}`,
  ])];
};

// Produce ranked candidates while retaining the reason and source pattern.
export const rankedCandidateEmails = (
  row: Record<string, string>,
  emailColumn?: string,
  firstNameColumn?: string,
  lastNameColumn?: string,
  domainColumn?: string,
): RankedCandidate[] => {
  const candidates = candidateEmails(
    row,
    emailColumn,
    firstNameColumn,
    lastNameColumn,
    domainColumn,
  );
  if (candidates.length === 0) return [];
  const existing = valueFromRow(row, emailColumn);
  if (existing) {
    return [{
      email: existing.toLowerCase(),
      score: 100,
      provenance: "source-email",
    }];
  }
  const patterns = [
    "first.last",
    "first_last",
    "first",
    "initiallast",
  ];
  return candidates.map((email, index) => ({
    email,
    score: [90, 70, 55, 40][index] || 20,
    provenance: `candidate-pattern:${patterns[index] || "other"}`,
  }));
};

// Escapes a value for a standards-compatible CSV field.
export const csvEscape = (value: unknown): string => {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\r\n]/.test(text)
    ? `"${text.replace(/"/g, '""')}"`
    : text;
};
