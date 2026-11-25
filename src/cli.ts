import fs from "node:fs";
import path from "node:path";

export const getCliVersion = (): string => {
  const packageJsonPath = path.resolve(
    __dirname,
    "..",
    "package.json",
  );
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(packageJsonPath, "utf8"),
    ) as { version?: string };
    return packageJson.version || "unknown";
  } catch {
    return "unknown";
  }
};

export const printCliHelp = (): string => `Lead Enrichment CLI

Usage:
  lead-enrichment --serve
  lead-enrichment --input <csv> [options]

Modes:
  --serve                    Start the HTTP enrichment service

Job options:
  --input <path>             Input CSV path on the enrichment host
  --output <path>            Optional output CSV path
  --provider <name>          builtin, mailtester_ninja, reacher, or qev
  --provider-call-limit <n>  Maximum provider calls for this job
  --batch-size <n>           Source rows buffered before each verification batch
  --email-column <name>      CSV column containing an existing email
  --first-name-column <name> CSV column containing first names
  --last-name-column <name>  CSV column containing last names
  --full-name-column <name>  CSV column containing combined full names
  --domain-column <name>     CSV column containing company domains
  --retain-missing-email     Keep rows without a candidate email in the output

Information:
  -h, --help                 Show this help text
  -v, --version              Show the package version

Examples:
  lead-enrichment --serve
  lead-enrichment --input ./data/input/leads.csv --provider builtin
  lead-enrichment --input ./leads.csv --first-name-column first_name --last-name-column last_name --domain-column domain
`;
