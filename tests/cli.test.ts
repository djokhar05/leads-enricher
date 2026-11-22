import assert from "node:assert/strict";
import { test } from "node:test";
import { getCliVersion, printCliHelp } from "../src/cli";

test("CLI help lists server mode and all job options", () => {
  const help = printCliHelp();
  assert.match(help, /--serve/);
  assert.match(help, /--input <path>/);
  assert.match(help, /--provider-call-limit <n>/);
  assert.match(help, /-h, --help/);
  assert.match(help, /-v, --version/);
});

test("CLI version comes from package metadata", () => {
  assert.equal(getCliVersion(), "1.0.0");
});
