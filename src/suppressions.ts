import fs from "node:fs";
import { parse } from "csv-parse/sync";
import { config } from "./config";

let loadedPath = "";
let suppressions = new Set<string>();

const normalize = (email: string): string =>
  email.trim().toLowerCase();

export const loadSuppressions = (): Set<string> => {
  if (!config.suppressionsPath) return suppressions;
  if (loadedPath === config.suppressionsPath && suppressions.size >= 0) {
    return suppressions;
  }
  if (!fs.existsSync(config.suppressionsPath)) {
    suppressions = new Set();
    loadedPath = config.suppressionsPath;
    return suppressions;
  }
  const records = parse(fs.readFileSync(config.suppressionsPath), {
    bom: true,
    columns: true,
    relax_column_count: true,
  }) as Array<Record<string, string>>;
  suppressions = new Set(
    records
      .flatMap((record) =>
        Object.entries(record)
          .filter(([key]) => /email|address/i.test(key))
          .map(([, value]) => normalize(String(value || ""))),
      )
      .filter(Boolean),
  );
  loadedPath = config.suppressionsPath;
  return suppressions;
};

export const isSuppressed = (email: string): boolean =>
  loadSuppressions().has(normalize(email));
