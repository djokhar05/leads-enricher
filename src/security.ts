import path from "node:path";
import type { RequestHandler } from "express";
import { config } from "./config";

export const requireServiceAuth: RequestHandler = (req, res, next) => {
  if (!config.authToken) {
    res.status(503).json({
      error: "LEAD_ENRICHMENT_AUTH_TOKEN is required",
    });
    return;
  }
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : "";
  if (token !== config.authToken) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
};

const inside = (root: string, target: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative));
};

export const resolveAllowedInputPath = (inputPath: string): string => {
  const resolved = path.resolve(inputPath);
  if (!inside(config.inputDir, resolved)) {
    throw new Error("Input path is outside the allowed input directory");
  }
  return resolved;
};

export const resolveAllowedOutputPath = (outputPath: string): string => {
  const resolved = path.resolve(outputPath);
  if (!inside(config.outputDir, resolved)) {
    throw new Error("Output path is outside the allowed output directory");
  }
  return resolved;
};
