"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectCsvHeaderMappings = exports.splitFullName = exports.normalizeDomain = exports.csvEscape = exports.rankedCandidateEmails = exports.candidateEmails = exports.stableRowId = exports.valueFromRow = void 0;
const node_crypto_1 = require("node:crypto");
// Reads a selected source column without guessing column names.
const valueFromRow = (row, columnName) => {
    if (!columnName)
        return "";
    return String(row[columnName] || "").trim();
};
exports.valueFromRow = valueFromRow;
// The row ID includes the row position and source values so it remains stable
// when downstream systems preserve or re-import the same input row.
const stableRowId = (row, rowNumber) => (0, node_crypto_1.createHash)("sha256")
    .update(JSON.stringify({ rowNumber, row }))
    .digest("hex")
    .slice(0, 20);
exports.stableRowId = stableRowId;
const candidateEmails = (row, emailColumn, firstNameColumn, lastNameColumn, domainColumn, fullNameColumn) => {
    const existing = (0, exports.valueFromRow)(row, emailColumn);
    // A supplied address is authoritative; do not generate alternatives for it.
    if (existing)
        return [existing.toLowerCase()];
    let first = (0, exports.valueFromRow)(row, firstNameColumn).toLowerCase();
    let last = (0, exports.valueFromRow)(row, lastNameColumn).toLowerCase();
    if ((!first || !last) && fullNameColumn) {
        const split = (0, exports.splitFullName)((0, exports.valueFromRow)(row, fullNameColumn));
        first = first || split.firstName.toLowerCase();
        last = last || split.lastName.toLowerCase();
    }
    const domain = (0, exports.valueFromRow)(row, domainColumn).toLowerCase();
    if (!first || !last || !domain)
        return [];
    const normalizedFirst = first.replace(/[^a-z0-9]/g, "");
    const normalizedLast = last.replace(/[^a-z0-9]/g, "");
    if (!normalizedFirst || !normalizedLast)
        return [];
    // Pattern generation is deliberately simple and provenance is recorded by the
    // caller. These values are candidates, not confirmed identities or mailboxes.
    return [...new Set([
            `${normalizedFirst}.${normalizedLast}@${domain}`,
            `${normalizedFirst}_${normalizedLast}@${domain}`,
            `${normalizedFirst}@${domain}`,
            `${normalizedFirst[0]}${normalizedLast}@${domain}`,
        ])];
};
exports.candidateEmails = candidateEmails;
// Produce ranked candidates while retaining the reason and source pattern.
const rankedCandidateEmails = (row, emailColumn, firstNameColumn, lastNameColumn, domainColumn, fullNameColumn) => {
    const candidates = (0, exports.candidateEmails)(row, emailColumn, firstNameColumn, lastNameColumn, domainColumn, fullNameColumn);
    if (candidates.length === 0)
        return [];
    const existing = (0, exports.valueFromRow)(row, emailColumn);
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
exports.rankedCandidateEmails = rankedCandidateEmails;
// Escapes a value for a standards-compatible CSV field.
const csvEscape = (value) => {
    const text = value === undefined || value === null ? "" : String(value);
    return /[",\r\n]/.test(text)
        ? `"${text.replace(/"/g, '""')}"`
        : text;
};
exports.csvEscape = csvEscape;
const normalizeDomain = (value) => {
    const trimmed = value.trim();
    if (!trimmed)
        return "";
    try {
        const withScheme = /^https?:\/\//i.test(trimmed)
            ? trimmed
            : `https://${trimmed}`;
        return new URL(withScheme).hostname
            .replace(/^www\./i, "")
            .toLowerCase();
    }
    catch {
        return trimmed
            .replace(/^https?:\/\//i, "")
            .replace(/\/.*$/, "")
            .replace(/^www\./i, "")
            .toLowerCase();
    }
};
exports.normalizeDomain = normalizeDomain;
const splitFullName = (value) => {
    let cleaned = value
        .replace(/[^a-zA-Z0-9' .-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    cleaned = cleaned
        .replace(/^(dr\.?|mr\.?|mrs\.?|ms\.?|prof\.?|sir|dame)\s+/i, "")
        .replace(/\s+(jr\.?|sr\.?|ii|iii|iv)$/i, "")
        .trim();
    if (!cleaned)
        return { firstName: "", lastName: "" };
    const parts = cleaned.split(" ").filter(Boolean);
    if (parts.length < 2)
        return { firstName: "", lastName: "" };
    return {
        firstName: parts[0],
        lastName: parts.slice(1).join(" "),
    };
};
exports.splitFullName = splitFullName;
const normalizedHeader = (header) => header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
const detectCsvHeaderMappings = (headers) => {
    const normalized = headers.map((header) => ({
        original: header,
        normalized: normalizedHeader(header),
    }));
    const find = (aliases) => normalized.find((header) => aliases.includes(header.normalized))
        ?.original;
    const result = {
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
    if (websiteColumn)
        result.websiteColumn = websiteColumn;
    if (addressColumn)
        result.addressColumn = addressColumn;
    if (companyNameColumn)
        result.companyNameColumn = companyNameColumn;
    if (ownerNameColumn)
        result.ownerNameColumn = ownerNameColumn;
    if (fullNameColumn)
        result.fullNameColumn = fullNameColumn;
    if (emailColumn)
        result.emailColumn = emailColumn;
    if (firstNameColumn)
        result.firstNameColumn = firstNameColumn;
    if (lastNameColumn)
        result.lastNameColumn = lastNameColumn;
    if (domainColumn)
        result.domainColumn = domainColumn;
    return result;
};
exports.detectCsvHeaderMappings = detectCsvHeaderMappings;
