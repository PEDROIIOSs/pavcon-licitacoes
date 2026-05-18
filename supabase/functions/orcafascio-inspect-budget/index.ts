// =============================================================================
// Edge Function: orcafascio-inspect-budget
// =============================================================================
// FERRAMENTA DE INVESTIGAÇÃO (não usar em produção).
// Pega um orçamento existente no Orçafascio e retorna o HTML da página +
// trechos com forms/endpoints pra eu descobrir como o Orçafascio aceita
// pu customizado por item.
//
// Body:
//   {
//     "credential_id": "uuid",       // orcafascio + auth_type=web
//     "budget_id": "6a087cb1...",    // 24 hex chars
//     "extra_paths": ["..."]         // opcional — paths extras pra inspecionar
//   }
//
// Resposta: { ok, paths: [{ path, status, html_excerpt, candidate_endpoints }] }
// =============================================================================

import { handleCorsPreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/json.ts';
import { getServiceRoleClient } from '../_shared/supabase.ts';
import {
  authenticateOrcafascioWeb,
  OrcafascioWebError,
} from '../_shared/orcafascio-web.ts';

const BASE = 'https://app.orcafascio.com';

interface RequestBody {
  credential_id?: string;
  budget_id?: string;
  extra_paths?: string[];
  /** Se true, retorna o HTML completo (truncado em 100k) em vez de excerpts */
  return_full_html?: boolean;
}

Deno.serve(async (req: Request) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse(405, 'Use POST.');

  let body: RequestBody;
  try { body = await req.json(); } catch { return errorResponse(400, 'JSON inválido.'); }

  const credentialId = body.credential_id?.trim();
  const budgetId = body.budget_id?.trim();
  if (!credentialId || !budgetId) {
    return errorResponse(400, 'credential_id e budget_id são obrigatórios.');
  }

  const admin = getServiceRoleClient();
  try {
    const session = await authenticateOrcafascioWeb(admin, credentialId, {
      callerUserId: '00000000-0000-0000-0000-000000000000',
      traceId: crypto.randomUUID(),
    });

    const paths = [
      `/v2023/home`,           // página inicial (sanity check)
      `/orc/orcamentos`,       // listagem
      `/orc/orcamentos/${budgetId}`,
      `/orc/orcamentos/${budgetId}/edit`,
      `/v2023/bud/budgets/${budgetId}`,
      `/v2023/bud/budgets/${budgetId}/items`,
      ...(body.extra_paths ?? []),
    ];

    const results: Array<Record<string, unknown>> = [];
    for (const path of paths) {
      try {
        const r = await fetch(`${BASE}${path}`, {
          method: 'GET',
          headers: {
            Cookie: session.cookie_header,
            'User-Agent': 'pavcon-licitacoes/0.1 (inspector)',
            Accept: 'text/html, application/json, */*',
          },
          redirect: 'manual',
        });
        const text = await r.text();

        // Extrai candidatos: forms, URLs interessantes, inputs com names suspeitos
        const forms = Array.from(text.matchAll(/<form[^>]+action=["']([^"']+)["'][^>]*>/g))
          .map((m) => m[1]).slice(0, 50);
        const allUrls = Array.from(text.matchAll(/["'`](\/v?2?0?2?3?\/(?:orc|bud)[\w\/-]+)["'`]/g))
          .map((m) => m[1]);
        const dataLinks = Array.from(text.matchAll(/data-(?:link|url)=["']([^"']+)["']/g))
          .map((m) => m[1]);
        const interestingInputs = Array.from(
          text.matchAll(/<input[^>]+name=["']([^"']*(?:pu|preco|price|manual|custo|valor|insumo)[^"']*)["'][^>]*>/g)
        ).map((m) => m[1]).slice(0, 100);

        // Busca SEÇÕES do HTML por palavras-chave (cada hit = ±400 chars de contexto)
        const keywords = [
          'preço unitário manual',
          'preco_unitario_manual',
          'pu_manual',
          'pu_custom',
          'pu_user',
          'pun_manual',
          'edit_item',
          'editar item',
          'preço manual',
          'preco_manual',
          'bud_item',
          'budget_item',
          'unit_price',
          'manual_price',
          'override',
          'changePrice',
          'updatePrice',
          'price_input',
          'price_form',
          'modal-preco',
          'modal-edit',
          'flaticon-edit',
          'editar preço',
        ];
        const hits: Array<{ kw: string; idx: number; ctx: string }> = [];
        for (const kw of keywords) {
          const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
          let from = 0;
          while (hits.length < 60) {
            const m = text.slice(from).match(re);
            if (!m || m.index === undefined) break;
            const abs = from + m.index;
            hits.push({
              kw,
              idx: abs,
              ctx: text.slice(Math.max(0, abs - 200), Math.min(text.length, abs + 400)),
            });
            from = abs + m[0].length;
            if (hits.length > 20) break; // limite por keyword
          }
        }

        results.push({
          path,
          status: r.status,
          location: r.headers.get('location'),
          length: text.length,
          forms,
          urls: [...new Set(allUrls)].slice(0, 100),
          dataLinks: [...new Set(dataLinks)].slice(0, 50),
          interestingInputs: [...new Set(interestingInputs)],
          keywordHits: hits,
          ...(body.return_full_html
            ? (() => {
              // Pula seção de modals/dropdowns (categorias) e procura tabela de items
              const tableMarkers = ['orcamento_items', 'budget-items', 'sh-tableresponsive', 'tr_item_', 'data-itemization'];
              let bestIdx = -1;
              for (const k of tableMarkers) {
                const idx = text.indexOf(k);
                if (idx >= 0 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx;
              }
              // Se achou marcador da tabela, retorna 200k a partir dali
              if (bestIdx >= 0) {
                return { html: text.slice(Math.max(0, bestIdx - 1000), Math.min(bestIdx + 200000, text.length)) };
              }
              // Fallback: pega último 200k da página (geralmente items estão no fim)
              return { html: text.slice(Math.max(0, text.length - 200000)) };
            })()
            : {}),
        });
      } catch (e) {
        results.push({ path, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return jsonResponse({ ok: true, results });
  } catch (err) {
    if (err instanceof OrcafascioWebError) {
      return errorResponse(500, err.message, err.details);
    }
    return errorResponse(500, err instanceof Error ? err.message : String(err));
  }
});
