// Resposta JSON padrão para Edge Functions, com CORS embutido.

import { corsHeaders } from './cors.ts';

export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}

export function errorResponse(
  status: number,
  message: string,
  details?: unknown,
): Response {
  return jsonResponse({ error: message, details: details ?? null }, status);
}
