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
  fullNameColumn?: string,
): string[] => {
  const existing = valueFromRow(row, emailColumn);
  // A supplied address is authoritative; do not generate alternatives for it.
  if (existing) return [existing.toLowerCase()];

  let first = valueFromRow(row, firstNameColumn).toLowerCase();
  let last = valueFromRow(row, lastNameColumn).toLowerCase();
  if ((!first || !last) && fullNameColumn) {
    const split = splitFullName(valueFromRow(row, fullNameColumn));
    first = first || split.firstName.toLowerCase();
    last = last || split.lastName.toLowerCase();
  }
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
  fullNameColumn?: string,
): RankedCandidate[] => {
  const candidates = candidateEmails(
    row,
    emailColumn,
    firstNameColumn,
    lastNameColumn,
    domainColumn,
    fullNameColumn,
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

export const normalizeDomain = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const withScheme = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    return new URL(withScheme).hostname
      .replace(/^www\./i, "")
      .toLowerCase();
  } catch {
    return trimmed
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .replace(/^www\./i, "")
      .toLowerCase();
  }
};

export interface SplitFullName {
  firstName: string;
  lastName: string;
}

export const splitFullName = (value: string): SplitFullName => {
  let cleaned = value
    .replace(/[^a-zA-Z0-9' .-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  cleaned = cleaned
    .replace(
      /^(dr\.?|mr\.?|mrs\.?|ms\.?|prof\.?|sir|dame)\s+/i,
      "",
    )
    .replace(/\s+(jr\.?|sr\.?|ii|iii|iv)$/i, "")
    .trim();
  if (!cleaned) return { firstName: "", lastName: "" };
  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length < 2) return { firstName: "", lastName: "" };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
};

export interface CsvHeaderMappings {
  emailColumn?: string;
  firstNameColumn?: string;
  lastNameColumn?: string;
  domainColumn?: string;
  companyNameColumn?: string;
  websiteColumn?: string;
  addressColumn?: string;
  ownerNameColumn?: string;
  fullNameColumn?: string;
  headers: string[];
}

const normalizedHeader = (header: string): string =>
  header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

export const detectCsvHeaderMappings = (
  headers: string[],
): CsvHeaderMappings => {
  const normalized = headers.map((header) => ({
    original: header,
    normalized: normalizedHeader(header),
  }));
  const find = (aliases: string[]): string | undefined =>
    normalized.find((header) => aliases.includes(header.normalized))
      ?.original;

  const result: CsvHeaderMappings = {
    headers,
  };
  const websiteColumn = find([
      "website",
      "website_url",
      "website_or_social_url",
      "company_website",
      "company_url",
      "domain",
      "company_domain",
  ]);
  const addressColumn = find([
      "address",
      "full_address",
      "company_address",
      "location",
  ]);
  const companyNameColumn = find([
      "name",
      "company_name",
      "company",
      "business_name",
      "organization",
  ]);
  const ownerNameColumn = find([
    "owner_name",
    "owner",
    "contact_name",
    "decision_maker",
  ]);
  const fullNameColumn = find([
    "full_name",
    "fullname",
    "founder_name",
    "contact_full_name",
    "person_name",
  ]);
  const emailColumn = find([
      "email",
      "email_address",
      "emailaddress",
      "work_email",
      "workemail",
      "business_email",
      "e_mail",
  ]);
  const firstNameColumn = find([
      "first_name",
      "firstname",
      "given_name",
      "givenname",
      "fname",
  ]);
  const lastNameColumn = find([
      "last_name",
      "lastname",
      "surname",
      "family_name",
      "familyname",
      "lname",
  ]);
  const domainColumn = find([
      "domain",
      "company_domain",
      "companydomain",
      "website",
      "web_domain",
      "webdomain",
  ]);
  if (websiteColumn) result.websiteColumn = websiteColumn;
  if (addressColumn) result.addressColumn = addressColumn;
  if (companyNameColumn) result.companyNameColumn = companyNameColumn;
  if (ownerNameColumn) result.ownerNameColumn = ownerNameColumn;
  if (fullNameColumn) result.fullNameColumn = fullNameColumn;
  if (emailColumn) result.emailColumn = emailColumn;
  if (firstNameColumn) result.firstNameColumn = firstNameColumn;
  if (lastNameColumn) result.lastNameColumn = lastNameColumn;
  if (domainColumn) result.domainColumn = domainColumn;
  return result;
};
