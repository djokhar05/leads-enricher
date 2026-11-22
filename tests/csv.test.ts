import assert from "node:assert/strict";
import { test } from "node:test";
import {
  candidateEmails,
  csvEscape,
  rankedCandidateEmails,
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
