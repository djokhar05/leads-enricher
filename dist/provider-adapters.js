"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.testLlmConnection = exports.enrichWithLlm = exports.findCandidates = void 0;
const config_1 = require("./config");
const findCandidates = async (input) => {
    if (!config_1.config.finderBaseUrl)
        return null;
    const response = await fetch(`${config_1.config.finderBaseUrl.replace(/\/$/, "")}/find`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(config_1.config.finderAuthToken
                ? { Authorization: `Bearer ${config_1.config.finderAuthToken}` }
                : {}),
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
        throw new Error(`Finder provider returned HTTP ${response.status}`);
    }
    const body = await response.json();
    return {
        candidates: (body.candidates || [])
            .filter((candidate) => typeof candidate === "string")
            .map((candidate) => candidate.trim().toLowerCase())
            .filter(Boolean),
        costEstimateUsd: Number(body.costEstimateUsd) || 0,
        tokenCount: Number(body.tokenCount) || 0,
        provenance: body.provenance || "finder-provider",
    };
};
exports.findCandidates = findCandidates;
const enrichWithLlm = async (input, signal) => {
    signal?.throwIfAborted();
    if (!config_1.config.llmEnabled) {
        return null;
    }
    const prompt = "Extract or infer the most likely owner, founder, or CEO full name for this business. " +
        "Use team pages, about pages, contact pages, or search snippets. " +
        "If no name is explicitly stated, infer from context clues (e.g. 'Founded by', 'Meet our team', 'Owner'). " +
        "Return JSON: " +
        '{"names":[{"firstName":"","lastName":"","confidence":0,"source":""}]}';
    const parseNames = (content) => {
        let names = [];
        try {
            const normalized = content
                .trim()
                .replace(/^```(?:json)?/i, "")
                .replace(/```$/, "")
                .trim();
            const parsed = JSON.parse(normalized);
            if (Array.isArray(parsed.names)) {
                names = parsed.names
                    .filter((name) => typeof name.firstName === "string" &&
                    typeof name.lastName === "string")
                    .map((name) => `${String(name.firstName).trim()} ${String(name.lastName).trim()}`)
                    .filter((name) => name.trim().length > 1);
            }
        }
        catch {
            names = [];
        }
        return names;
    };
    const callGemini = async () => {
        if (!config_1.config.llmApiKey)
            return null;
        const baseUrl = config_1.config.llmBaseUrl ||
            "https://generativelanguage.googleapis.com/v1beta";
        const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(config_1.config.llmModel)}:generateContent`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": config_1.config.llmApiKey,
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
        });
        if (!response.ok) {
            throw new Error(`Gemini returned HTTP ${response.status}`);
        }
        const body = await response.json();
        const content = body.candidates?.[0]?.content?.parts
            ?.map((part) => part.text || "")
            .join("") || "[]";
        return {
            names: parseNames(content),
            costEstimateUsd: 0,
            tokenCount: Number(body.usageMetadata?.totalTokenCount) || 0,
        };
    };
    const callOpenAI = async (apiKey, baseUrl, model) => {
        if (!apiKey)
            return null;
        const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
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
        });
        if (!response.ok) {
            throw new Error(`OpenAI returned HTTP ${response.status}`);
        }
        const body = await response.json();
        const content = body.choices?.[0]?.message?.content || '{"names":[]}';
        return {
            names: parseNames(content),
            costEstimateUsd: 0,
            tokenCount: Number(body.usage?.total_tokens) || 0,
        };
    };
    try {
        if (config_1.config.llmProvider === "gemini") {
            const primary = await callGemini();
            if (primary)
                return primary;
            return await callOpenAI(config_1.config.llmFallbackApiKey, config_1.config.llmFallbackBaseUrl, config_1.config.llmFallbackModel);
        }
        const primary = await callOpenAI(config_1.config.llmApiKey, config_1.config.llmBaseUrl ||
            "https://api.openai.com/v1", config_1.config.llmModel);
        if (primary)
            return primary;
        return await callOpenAI(config_1.config.llmFallbackApiKey, config_1.config.llmFallbackBaseUrl, config_1.config.llmFallbackModel);
    }
    catch {
        signal?.throwIfAborted();
        try {
            return await callOpenAI(config_1.config.llmFallbackApiKey, config_1.config.llmFallbackBaseUrl, config_1.config.llmFallbackModel);
        }
        catch {
            signal?.throwIfAborted();
            return null;
        }
    }
};
exports.enrichWithLlm = enrichWithLlm;
const testLlmConnection = async () => {
    const provider = config_1.config.llmProvider;
    const model = config_1.config.llmModel;
    const key = config_1.config.llmApiKey;
    if (!config_1.config.llmEnabled) {
        return { ok: false, provider, model, configured: false, responseNames: [], error: "LEAD_LLM_ENABLED is false" };
    }
    if (!key) {
        return { ok: false, provider, model, configured: false, responseNames: [], error: "LEAD_LLM_API_KEY is not configured" };
    }
    const prompt = 'Return JSON exactly: {"names":[{"firstName":"Ada","lastName":"Lovelace","confidence":1,"source":"connection-test"}]}';
    try {
        if (provider === "gemini") {
            const baseUrl = config_1.config.llmBaseUrl ||
                "https://generativelanguage.googleapis.com/v1beta";
            const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(model)}:generateContent`, {
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
            });
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
            const body = await response.json();
            const content = body.candidates?.[0]?.content?.parts
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
        const baseUrl = config_1.config.llmBaseUrl || "https://api.openai.com/v1";
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
        const body = await response.json();
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
    }
    catch (error) {
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
exports.testLlmConnection = testLlmConnection;
