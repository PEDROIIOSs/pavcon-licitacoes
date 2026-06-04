// Cliente Anthropic Claude pra Edge Functions.
// Usa documentos PDF nativamente (Claude 3.5 Sonnet+ e Opus suportam input PDF).
// Doc: https://docs.anthropic.com/en/api/messages

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { logIntegration } from './audit.ts';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Pricing claude-opus-4-7 (jan/2026 — atualizar quando mudar):
//   input  $15.00 / 1M tokens
//   output $75.00 / 1M tokens
// Para claude-sonnet-4-7:
//   input  $3.00  / 1M tokens
//   output $15.00 / 1M tokens
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-7':    { input: 15.0 / 1_000_000, output: 75.0 / 1_000_000 },
  'claude-opus-4-5':    { input: 15.0 / 1_000_000, output: 75.0 / 1_000_000 },
  'claude-sonnet-4-7':  { input: 3.0  / 1_000_000, output: 15.0 / 1_000_000 },
  'claude-sonnet-4-5':  { input: 3.0  / 1_000_000, output: 15.0 / 1_000_000 },
  'claude-3-5-sonnet-20241022': { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
};

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ClaudeCallResult {
  status: number;
  text: string | null;
  usage: ClaudeUsage;
  rawJson: unknown;
  estimatedCostUsd: number;
  stopReason: string | null;
}

export type ClaudeContent =
  | { type: 'text'; text: string }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } };

export class ClaudeError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ClaudeError';
  }
}

export function estimateClaudeCost(model: string, usage: ClaudeUsage): number {
  const p = PRICING[model] ?? { input: 15.0 / 1_000_000, output: 75.0 / 1_000_000 };
  const inputTokens = (usage.input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0) * 0.1; // cache_read é 10% do preço
  const outputTokens = usage.output_tokens ?? 0;
  return inputTokens * p.input + outputTokens * p.output;
}

interface CallClaudeOpts {
  model: string;
  apiKey: string;
  systemPrompt: string;
  userContent: ClaudeContent[];
  maxTokens?: number;
  temperature?: number;
  admin: SupabaseClient;
  callerUserId: string;
  licitacaoId?: string | null;
  traceId?: string;
}

/**
 * Chama o Anthropic Messages API. Audita, calcula custo e devolve texto +
 * usage. Lança ClaudeError em status não-2xx.
 */
export async function callClaude(opts: CallClaudeOpts): Promise<ClaudeCallResult> {
  const startedAt = Date.now();

  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 16000,
    temperature: opts.temperature ?? 0.1,
    system: opts.systemPrompt,
    messages: [
      {
        role: 'user',
        content: opts.userContent,
      },
    ],
  };

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  const rawText = await response.text();
  let parsed: unknown = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    parsed = null;
  }

  // Mascarar API key no audit log (já é mascarada via maskSecrets no helper)
  await logIntegration(opts.admin, {
    user_id: opts.callerUserId,
    licitacao_id: opts.licitacaoId ?? null,
    provider: 'anthropic',
    endpoint: ANTHROPIC_API_URL,
    metodo_http: 'POST',
    request_payload: {
      model: opts.model,
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      content_summary: opts.userContent.map((c) =>
        c.type === 'text'
          ? { type: 'text', length: c.text.length }
          : { type: 'document', mime: c.source.media_type, bytes_b64: c.source.data.length }
      ),
    },
    response_status: response.status,
    response_payload: parsed
      ? {
        id: (parsed as { id?: string }).id,
        type: (parsed as { type?: string }).type,
        stop_reason: (parsed as { stop_reason?: string }).stop_reason,
        usage: (parsed as { usage?: ClaudeUsage }).usage,
        // Inclui o objeto `error` da resposta da Anthropic em caso de 4xx/5xx
        // (mensagem + type). Sem isso, debug de 400 fica cego (só "type:error").
        error: (parsed as { error?: { type?: string; message?: string } }).error,
      }
      : { raw: rawText.slice(0, 500) },
    duracao_ms: Date.now() - startedAt,
    custo_usd: parsed
      ? estimateClaudeCost(opts.model, (parsed as { usage?: ClaudeUsage }).usage ?? {})
      : null,
    trace_id: opts.traceId ?? null,
  });

  if (!response.ok) {
    throw new ClaudeError(
      response.status,
      `Claude respondeu ${response.status}.`,
      parsed ?? rawText.slice(0, 500),
    );
  }
  if (!parsed) {
    throw new ClaudeError(502, 'Resposta do Claude não é JSON.', rawText.slice(0, 500));
  }

  const contentBlocks = (parsed as {
    content?: Array<{ type: string; text?: string }>;
  }).content;
  if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) {
    throw new ClaudeError(502, 'Claude retornou sem content.', parsed);
  }
  // Concatena todos os blocos de texto (geralmente é só 1)
  const text = contentBlocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  if (!text) {
    throw new ClaudeError(502, 'Claude não retornou texto.', parsed);
  }

  const usage = (parsed as { usage?: ClaudeUsage }).usage ?? {};
  const stopReason = (parsed as { stop_reason?: string }).stop_reason ?? null;

  return {
    status: response.status,
    text,
    usage,
    rawJson: parsed,
    estimatedCostUsd: estimateClaudeCost(opts.model, usage),
    stopReason,
  };
}
