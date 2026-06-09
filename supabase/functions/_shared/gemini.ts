// Cliente leve para a API REST do Gemini.
// Usado pela Edge Function extracao-edital pra enviar PDFs ao Gemini 2.5 Pro
// e receber JSON estruturado.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { logIntegration } from './audit.ts';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Pricing de janeiro 2026 (gemini-2.5-pro). Atualizar quando mudar.
//   <200K input: $1.25/M tokens   |  >200K: $2.50/M
//   <200K output: $10.00/M tokens |  >200K: $15.00/M
const PRICE_INPUT_LOW = 1.25 / 1_000_000;
const PRICE_INPUT_HIGH = 2.50 / 1_000_000;
const PRICE_OUTPUT_LOW = 10.0 / 1_000_000;
const PRICE_OUTPUT_HIGH = 15.0 / 1_000_000;
const TIER_THRESHOLD = 200_000;

export interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

export interface GeminiCallResult {
  status: number;
  text: string | null;
  usage: GeminiUsage;
  rawJson: unknown;
  estimatedCostUsd: number;
  modelUsed: string; // pode diferir do opts.model quando houve fallback
}

export interface GeminiInlinePart {
  inlineData: { mimeType: string; data: string };
}

export interface GeminiTextPart {
  text: string;
}

export type GeminiPart = GeminiInlinePart | GeminiTextPart;

export class GeminiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

export function estimateGeminiCost(usage: GeminiUsage): number {
  const inputTokens = usage.promptTokenCount ?? 0;
  const outputTokens = usage.candidatesTokenCount ?? 0;
  const inputPrice = inputTokens > TIER_THRESHOLD ? PRICE_INPUT_HIGH : PRICE_INPUT_LOW;
  const outputPrice = outputTokens > TIER_THRESHOLD
    ? PRICE_OUTPUT_HIGH
    : PRICE_OUTPUT_LOW;
  return inputTokens * inputPrice + outputTokens * outputPrice;
}

interface CallGeminiOpts {
  model: string;            // ex.: "gemini-2.5-pro"
  apiKey: string;
  parts: GeminiPart[];
  responseJson?: boolean;   // exige application/json (default: true)
  temperature?: number;     // default: 0.1 (extração estruturada)
  maxOutputTokens?: number; // default: 32768
  // Para audit log:
  admin: SupabaseClient;
  callerUserId: string;
  licitacaoId?: string | null;
  traceId?: string;
}

// Modelos em ordem de fallback quando há 429 no modelo principal
const FALLBACK_MODELS: Record<string, string[]> = {
  'gemini-2.5-pro': ['gemini-2.5-flash', 'gemini-2.0-flash'],
  'gemini-2.5-flash': ['gemini-2.0-flash'],
};

const RETRY_DELAYS_MS = [10_000, 30_000, 60_000]; // 10s, 30s, 60s

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Chama generateContent no Gemini, audita a chamada e devolve o texto +
 * tokens usados + custo estimado. Lança GeminiError em status não-2xx.
 * Faz retry automático com backoff exponencial em caso de 429.
 * Se todos os retries falharem, tenta modelos de fallback.
 */
export async function callGemini(
  opts: CallGeminiOpts,
): Promise<GeminiCallResult> {
  // Tenta o modelo principal com retries, depois os fallbacks
  const modelsToTry = [opts.model, ...(FALLBACK_MODELS[opts.model] ?? [])];

  let lastError: GeminiError | null = null;

  for (const model of modelsToTry) {
    const result = await _callGeminiOnce(opts, model);
    if (result.ok) return result.value!;
    lastError = result.error!;
    // Só avança para fallback se for 429; outros erros lançam imediatamente
    if (lastError.status !== 429) throw lastError;
    console.warn(`[gemini] ${model} retornou 429 após retries — tentando modelo de fallback`);
  }

  throw lastError!;
}

async function _callGeminiOnce(
  opts: CallGeminiOpts,
  model: string,
): Promise<{ ok: true; value: GeminiCallResult } | { ok: false; error: GeminiError }> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1];
      console.warn(`[gemini] 429 recebido, aguardando ${delay / 1000}s antes da tentativa ${attempt + 1}/${RETRY_DELAYS_MS.length + 1} (modelo: ${model})`);
      await sleep(delay);
    }

    const result = await _executeGeminiRequest(opts, model);
    if (result.ok) return result;
    if (result.error!.status !== 429) return result; // erro não-retriable
    if (attempt === RETRY_DELAYS_MS.length) return result; // esgotou retries
  }
  // nunca chega aqui
  return { ok: false, error: new GeminiError(429, 'Retries esgotados') };
}

async function _executeGeminiRequest(
  opts: CallGeminiOpts,
  model: string,
): Promise<{ ok: true; value: GeminiCallResult } | { ok: false; error: GeminiError }> {
  const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${opts.apiKey}`;
  const startedAt = Date.now();

  const body = {
    contents: [{ parts: opts.parts }],
    generationConfig: {
      temperature: opts.temperature ?? 0.1,
      maxOutputTokens: opts.maxOutputTokens ?? 32768,
      ...(opts.responseJson !== false
        ? { responseMimeType: 'application/json' }
        : {}),
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const rawText = await response.text();
  let parsed: unknown = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    parsed = null;
  }

  // Mascarar a API key na URL antes de logar
  const safeUrl = url.replace(/key=[^&]+/, 'key=***');
  await logIntegration(opts.admin, {
    user_id: opts.callerUserId,
    licitacao_id: opts.licitacaoId ?? null,
    provider: 'gemini',
    endpoint: safeUrl,
    metodo_http: 'POST',
    request_payload: {
      model,
      parts_summary: opts.parts.map((p) =>
        'text' in p
          ? { type: 'text', length: p.text.length }
          : { type: 'inline', mime: p.inlineData.mimeType, bytes_b64: p.inlineData.data.length }
      ),
      generationConfig: body.generationConfig,
    },
    response_status: response.status,
    response_payload: parsed
      ? {
        candidates_summary:
          (parsed as { candidates?: Array<{ finishReason?: string }> }).candidates
            ?.map((c) => ({ finishReason: c.finishReason })) ?? null,
        usageMetadata: (parsed as { usageMetadata?: GeminiUsage }).usageMetadata,
      }
      : { raw: rawText.slice(0, 500) },
    duracao_ms: Date.now() - startedAt,
    custo_usd: parsed
      ? estimateGeminiCost(
        (parsed as { usageMetadata?: GeminiUsage }).usageMetadata ?? {},
      )
      : null,
    trace_id: opts.traceId ?? null,
  });

  if (!response.ok) {
    return {
      ok: false,
      error: new GeminiError(
        response.status,
        `Gemini respondeu ${response.status}.`,
        parsed ?? rawText.slice(0, 500),
      ),
    };
  }
  if (!parsed) {
    return {
      ok: false,
      error: new GeminiError(502, 'Resposta do Gemini não é JSON válido.', rawText.slice(0, 500)),
    };
  }

  const candidates = (parsed as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
  }).candidates;
  if (!candidates || candidates.length === 0) {
    return { ok: false, error: new GeminiError(502, 'Gemini não retornou candidates.', parsed) };
  }
  const finishReason = candidates[0].finishReason;
  const text = candidates[0].content?.parts?.[0]?.text ?? null;
  if (!text) {
    return {
      ok: false,
      error: new GeminiError(
        502,
        `Gemini terminou com finishReason="${finishReason}" mas sem texto.`,
        parsed,
      ),
    };
  }

  const usage = (parsed as { usageMetadata?: GeminiUsage }).usageMetadata ?? {};
  return {
    ok: true,
    value: {
      status: response.status,
      text,
      usage,
      rawJson: parsed,
      estimatedCostUsd: estimateGeminiCost(usage),
      modelUsed: model,
    },
  };
}
