import { config } from "./config";

export interface FinderInput {
  firstName?: string;
  lastName?: string;
  domain?: string;
  companyName?: string;
  sourceUrl?: string;
  sourceText?: string;
}

export interface FinderResult {
  candidates: string[];
  costEstimateUsd?: number;
  tokenCount?: number;
  provenance: string;
}

export interface LlmDiagnosticResult {
  names: string[];
  costEstimateUsd: number;
  tokenCount: number;
  status: "ok" | "disabled" | "no_key" | "provider_error";
  provider?: "gemini" | "openai";
  error?: string;
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
  signal?: AbortSignal,
): Promise<{ names: string[]; costEstimateUsd: number; tokenCount: number } | null> => {
  signal?.throwIfAborted();
  if (!config.llmEnabled) {
    return null;
  }
  const prompt =
    "From the provided text, extract only real people who hold an owner, founder, executive, director, principal, or partner role at this business. " +
    "Copy each name exactly as it is written in the text. " +
    "Do not return company names, job titles, departments, role addresses, or anyone without a stated role. " +
    "If no such person is stated, return an empty list. " +
    "Return JSON: " +
    '{"names":[{"firstName":"","lastName":"","confidence":0,"source":"short quote from the text"}]}';

  const parseNames = (content: string): string[] => {
    let names: string[] = [];
    try {
      const normalized = content
        .trim()
        .replace(/^```(?:json)?/i, "")
        .replace(/```$/, "")
        .trim();
      const parsed = JSON.parse(normalized) as {
        names?: Array<{ firstName?: unknown; lastName?: unknown }>;
      };
      if (Array.isArray(parsed.names)) {
        names = parsed.names
          .filter(
            (name) =>
              typeof name.firstName === "string" &&
              typeof name.lastName === "string",
          )
          .map((name) =>
            `${String(name.firstName).trim()} ${String(name.lastName).trim()}`,
          )
          .filter((name) => name.trim().length > 1);
      }
    } catch {
      names = [];
    }
    return names;
  };

  const callGemini = async (): Promise<{
    names: string[];
    costEstimateUsd: number;
    tokenCount: number;
  } | null> => {
    if (!config.llmApiKey) return null;
    const baseUrl =
      config.llmBaseUrl ||
      "https://generativelanguage.googleapis.com/v1beta";
    const response = await fetch(
      `${baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(
        config.llmModel,
      )}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": config.llmApiKey,
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: prompt }],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: JSON.stringify(input) }],
            },
          ],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            maxOutputTokens: 512,
          },
        }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Gemini returned HTTP ${response.status}`);
    }
    const body = await response.json() as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
      usageMetadata?: { totalTokenCount?: number };
    };
    const content =
      body.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || "")
        .join("") || "[]";
    return {
      names: parseNames(content),
      costEstimateUsd: 0,
      tokenCount: Number(body.usageMetadata?.totalTokenCount) || 0,
    };
  };

  const callOpenAI = async (
    apiKey: string,
    baseUrl: string,
    model: string,
  ): Promise<{
    names: string[];
    costEstimateUsd: number;
    tokenCount: number;
  } | null> => {
    if (!apiKey) return null;
    const response = await fetch(
      `${baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 512,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: JSON.stringify(input) },
          ],
        }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new Error(`OpenAI returned HTTP ${response.status}`);
    }
    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number };
    };
    const content =
      body.choices?.[0]?.message?.content || '{"names":[]}';
    return {
      names: parseNames(content),
      costEstimateUsd: 0,
      tokenCount: Number(body.usage?.total_tokens) || 0,
    };
  };

  try {
    if (config.llmProvider === "gemini") {
      const primary = await callGemini();
      if (primary?.names.length) return primary;
      return await callOpenAI(
        config.llmFallbackApiKey,
        config.llmFallbackBaseUrl,
        config.llmFallbackModel,
      );
    }
    const primary = await callOpenAI(
      config.llmApiKey,
      config.llmBaseUrl ||
        "https://api.openai.com/v1",
      config.llmModel,
    );
    if (primary?.names.length) return primary;
    return await callOpenAI(
      config.llmFallbackApiKey,
      config.llmFallbackBaseUrl,
      config.llmFallbackModel,
    );
  } catch {
    signal?.throwIfAborted();
    try {
      return await callOpenAI(
        config.llmFallbackApiKey,
        config.llmFallbackBaseUrl,
        config.llmFallbackModel,
      );
    } catch {
      signal?.throwIfAborted();
      return null;
    }
  }
};

export const testLlmConnection = async (): Promise<{
  ok: boolean;
  provider: "gemini" | "openai";
  model: string;
  configured: boolean;
  responseNames: string[];
  error?: string;
}> => {
  const provider = config.llmProvider;
  const model = config.llmModel;
  const key = config.llmApiKey;
  if (!config.llmEnabled) {
    return { ok: false, provider, model, configured: false, responseNames: [], error: "LEAD_LLM_ENABLED is false" };
  }
  if (!key) {
    return { ok: false, provider, model, configured: false, responseNames: [], error: "LEAD_LLM_API_KEY is not configured" };
  }
  const prompt =
    'Return JSON exactly: {"names":[{"firstName":"Ada","lastName":"Lovelace","confidence":1,"source":"connection-test"}]}';
  try {
    if (provider === "gemini") {
      const baseUrl =
        config.llmBaseUrl ||
        "https://generativelanguage.googleapis.com/v1beta";
      const response = await fetch(
        `${baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": key,
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0,
              responseMimeType: "application/json",
              maxOutputTokens: 128,
            },
          }),
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!response.ok) {
        return {
          ok: false,
          provider,
          model,
          configured: true,
          responseNames: [],
          error: `Gemini returned HTTP ${response.status}`,
        };
      }
      const body = await response.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const content =
        body.candidates?.[0]?.content?.parts
          ?.map((part) => part.text || "")
          .join("") || "";
      const ok = content.includes("Ada");
      return {
        ok,
        provider,
        model,
        configured: true,
        responseNames: ok ? ["Ada Lovelace"] : [],
        error: ok ? undefined : "Gemini returned no expected test name",
      };
    }
    const baseUrl = config.llmBaseUrl || "https://api.openai.com/v1";
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: prompt }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      return {
        ok: false,
        provider,
        model,
        configured: true,
        responseNames: [],
        error: `OpenAI-compatible provider returned HTTP ${response.status}`,
      };
    }
    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content || "";
    const ok = content.includes("Ada");
    return {
      ok,
      provider,
      model,
      configured: true,
      responseNames: ok ? ["Ada Lovelace"] : [],
      error: ok ? undefined : "Provider returned no expected test name",
    };
  } catch (error) {
    return {
      ok: false,
      provider,
      model,
      configured: true,
      responseNames: [],
      error: error instanceof Error ? error.message : "LLM connection test failed",
    };
  }
};
