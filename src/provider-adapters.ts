import { config } from "./config";

export interface FinderInput {
  firstName?: string;
  lastName?: string;
  domain?: string;
  companyName?: string;
}

export interface FinderResult {
  candidates: string[];
  costEstimateUsd?: number;
  tokenCount?: number;
  provenance: string;
}

export const findCandidates = async (
  input: FinderInput,
): Promise<FinderResult | null> => {
  if (!config.finderBaseUrl) return null;
  const response = await fetch(
    `${config.finderBaseUrl.replace(/\/$/, "")}/find`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.finderAuthToken
          ? { Authorization: `Bearer ${config.finderAuthToken}` }
          : {}),
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Finder provider returned HTTP ${response.status}`);
  }
  const body = await response.json() as {
    candidates?: unknown[];
    costEstimateUsd?: number;
    tokenCount?: number;
    provenance?: string;
  };
  return {
    candidates: (body.candidates || [])
      .filter((candidate): candidate is string =>
        typeof candidate === "string",
      )
      .map((candidate) => candidate.trim().toLowerCase())
      .filter(Boolean),
    costEstimateUsd: Number(body.costEstimateUsd) || 0,
    tokenCount: Number(body.tokenCount) || 0,
    provenance: body.provenance || "finder-provider",
  };
};

export const enrichWithLlm = async (
  input: FinderInput,
): Promise<{ names: string[]; costEstimateUsd: number; tokenCount: number } | null> => {
  if (!config.llmBaseUrl || !config.llmApiKey || !config.llmModel) {
    return null;
  }
  const response = await fetch(
    `${config.llmBaseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.llmApiKey}`,
      },
      body: JSON.stringify({
        model: config.llmModel,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "Extract only explicitly provided person names and their source context. Do not infer names or fabricate facts.",
          },
          { role: "user", content: JSON.stringify(input) },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`LLM provider returned HTTP ${response.status}`);
  }
  const body = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { total_tokens?: number };
  };
  const content = body.choices?.[0]?.message?.content || "[]";
  let names: string[] = [];
  try {
    const parsed = JSON.parse(content) as unknown;
    if (Array.isArray(parsed)) {
      names = parsed.filter((name): name is string =>
        typeof name === "string",
      );
    }
  } catch {
    names = [];
  }
  return {
    names,
    costEstimateUsd: 0,
    tokenCount: Number(body.usage?.total_tokens) || 0,
  };
};
