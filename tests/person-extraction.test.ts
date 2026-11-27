import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appearsInSource,
  extractDeterministicNames,
  extractJsonLdPeople,
  leadershipSnippet,
} from "../src/person-extraction";

test("JSON-LD Person names are extracted from nested structured data", () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    "@type": "Organization",
    founder: { "@type": "Person", name: "Jane Smith" },
  })}</script>`;
  assert.deepEqual(extractJsonLdPeople(html), ["Jane Smith"]);
});

test("titled names are found on both sides of the title and company labels are rejected", () => {
  const names = extractDeterministicNames({
    text: "Jane Smith, Founder and CEO. Director: Alex Jones. Founder: Our Team",
  });
  assert.ok(names.includes("Jane Smith"));
  assert.ok(names.includes("Alex Jones"));
  assert.ok(!names.some((name) => /Team/.test(name)));
});

test("leadership snippet keeps only text near leadership cues", () => {
  const text = `${"Lorem ipsum. ".repeat(200)}Meet our founder Jane Smith today.${"Dolor sit. ".repeat(200)}`;
  const snippet = leadershipSnippet(text);
  assert.ok(snippet.includes("Jane Smith"));
  assert.ok(snippet.length < text.length / 4);
});

test("model names must appear verbatim in the source text", () => {
  assert.equal(appearsInSource("Jane Smith", "Founder: jane   smith"), true);
  assert.equal(appearsInSource("Alex Jones", "Founder: Jane Smith"), false);
});
