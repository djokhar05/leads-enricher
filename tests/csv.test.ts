import assert from "node:assert/strict";
import { test } from "node:test";
import {
  candidateEmails,
  csvEscape,
  detectCsvHeaderMappings,
  normalizeDomain,
  rankedCandidateEmails,
  splitFullName,
  stableRowId,
} from "../src/csv";

test("candidate generation preserves existing email and generates deterministic patterns", () => {
  assert.deepEqual(
    candidateEmails(
      { email: "Known@Example.com" },
      "email",
      "first",
      "last",
      "domain",
    ),
    ["known@example.com"],
  );

  assert.deepEqual(
    candidateEmails(
      { first: "Ada", last: "Lovelace", domain: "example.com" },
      "email",
      "first",
      "last",
      "domain",
    ),
    [
      "ada.lovelace@example.com",
      "ada_lovelace@example.com",
      "ada@example.com",
      "alovelace@example.com",
    ],
  );
});

test("stable row IDs change when source content or row position changes", () => {
  const first = stableRowId({ email: "a@example.com" }, 1);
  assert.equal(first, stableRowId({ email: "a@example.com" }, 1));
  assert.notEqual(first, stableRowId({ email: "b@example.com" }, 1));
  assert.notEqual(first, stableRowId({ email: "a@example.com" }, 2));
});

test("CSV escaping preserves commas, quotes, and newlines", () => {
  assert.equal(csvEscape("plain"), "plain");
  assert.equal(csvEscape("one,two"), '"one,two"');
  assert.equal(csvEscape('say "hello"'), '"say ""hello"""');
});

test("ranked candidates preserve source email priority and pattern provenance", () => {
  assert.deepEqual(
    rankedCandidateEmails(
      { email: "known@example.com" },
      "email",
      "first",
      "last",
      "domain",
    ),
    [{
      email: "known@example.com",
      score: 100,
      provenance: "source-email",
    }],
  );
  const ranked = rankedCandidateEmails(
    { first: "Ada", last: "Lovelace", domain: "example.com" },
    "email",
    "first",
    "last",
    "domain",
  );
  assert.equal(ranked[0].score, 90);
  assert.equal(ranked[0].provenance, "candidate-pattern:first.last");
  assert.ok(ranked.every((candidate) => candidate.score > 0));
});

test("common CSV headers are detected automatically", () => {
  assert.deepEqual(
    detectCsvHeaderMappings([
      "Email Address",
      "First Name",
      "Last Name",
      "Company Domain",
    ]),
    {
      headers: [
        "Email Address",
        "First Name",
        "Last Name",
        "Company Domain",
      ],
      emailColumn: "Email Address",
      firstNameColumn: "First Name",
      lastNameColumn: "Last Name",
      domainColumn: "Company Domain",
      websiteColumn: "Company Domain",
    },
  );
});

test("company-only CSV headers and website domains are detected", () => {
  assert.deepEqual(
    detectCsvHeaderMappings([
      "name",
      "website",
      "address",
    ]),
    {
      headers: ["name", "website", "address"],
      websiteColumn: "website",
      addressColumn: "address",
      companyNameColumn: "name",
      domainColumn: "website",
    },
  );
  assert.equal(normalizeDomain("https://www.example.com/about"), "example.com");
  assert.equal(normalizeDomain("example.co.uk"), "example.co.uk");
});

test("synthetic AI names generate candidates independently of source header mappings", () => {
  const aiRecord = {
    __enriched_first_name: "Chris",
    __enriched_last_name: "Bulen",
    __enriched_domain: "3d.expert",
  };
  const ranked = rankedCandidateEmails(
    aiRecord,
    undefined,
    "__enriched_first_name",
    "__enriched_last_name",
    "__enriched_domain",
  );
  assert.equal(ranked.length, 4);
  assert.equal(ranked[0].email, "chris.bulen@3d.expert");
  assert.equal(ranked[0].provenance, "candidate-pattern:first.last");
});

test("combined/full-name fields split into candidate name parts", () => {
  assert.deepEqual(splitFullName("Ada Lovelace"), {
    firstName: "Ada",
    lastName: "Lovelace",
  });
  assert.deepEqual(splitFullName("Dr. Ada Lovelace Jr."), {
    firstName: "Ada",
    lastName: "Lovelace",
  });
  const ranked = rankedCandidateEmails(
    { founder_name: "Ada Lovelace", website_url: "briq.com" },
    undefined,
    undefined,
    undefined,
    "website_url",
    "founder_name",
  );
  assert.equal(ranked[0].email, "ada.lovelace@briq.com");
});

test("Latka-style CSV mappings detect company, website, and founder name", () => {
  assert.deepEqual(
    detectCsvHeaderMappings([
      "company_name",
      "website_url",
      "founder_name",
    ]),
    {
      headers: ["company_name", "website_url", "founder_name"],
      websiteColumn: "website_url",
      companyNameColumn: "company_name",
      fullNameColumn: "founder_name",
    },
  );
});
