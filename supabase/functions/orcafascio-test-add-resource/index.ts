// =============================================================================
// Edge Function: orcafascio-test-add-resource (TEMP — diagnóstico)
// =============================================================================
// Testa variações de payload/URL pra descobrir o formato correto de adicionar
// INSUMOS (resources) a uma composição no MyBase. O endpoint atual
// `/add-items` com `is_resource:true` está respondendo 500 pra resources mas
// 200 pra sub-composições — sinal de que insumos precisam de outro caminho.
//
// Body: { credential_id, composition_id, sample_code }
// =============================================================================

import { handleCorsPreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/json.ts';
import { getServiceRoleClient } from '../_shared/supabase.ts';
import {
  authenticateOrcafascio,
  orcafascioFetch,
} from '../_shared/orcafascio.ts';

interface RequestBody {
  credential_id?: string;
  composition_id?: string;
  /** Se true: cria uma composição NOVA do zero pra testar isoladamente */
  create_fresh?: boolean;
  /** Group_id (obrigatório se create_fresh) */
  group_id?: string;
  sample_code?: string;
  sample_bank?: string;
}

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse(405, 'POST.');

  let body: RequestBody;
  try { body = await req.json(); } catch { return errorResponse(400, 'JSON inválido.'); }

  const credentialId = body.credential_id?.trim();
  let compositionId = body.composition_id?.trim();
  if (!credentialId) return errorResponse(400, 'credential_id obrigatório.');
  if (!compositionId && !body.create_fresh) {
    return errorResponse(400, 'composition_id obrigatório ou create_fresh=true + group_id.');
  }
  const code = body.sample_code ?? '366';
  const bank = body.sample_bank ?? 'SINAPI';

  const admin = getServiceRoleClient();
  const session = await authenticateOrcafascio(admin, credentialId, {
    callerUserId: '00000000-0000-0000-0000-000000000000',
    traceId: crypto.randomUUID(),
  });

  // Se pedido, cria uma composição fresca pra teste isolado.
  // Tb chama add_bases pra configurar SINAPI/PI/02-2026 antes do test.
  let createdInfo: unknown = null;
  let addBasesInfo: unknown = null;
  if (body.create_fresh) {
    const stamp = Date.now().toString(36);
    const compBody = {
      code: `TEST_${stamp}`,
      second_code: '',
      description: `Test composition ${stamp}`,
      labor: false,
      type: 'PARE',
      unit: 'un',
      local: 'PI',
      is_sicro: false,
      rounding_type: 2,
      note: 'test',
    };
    const c = await orcafascioFetch(admin, credentialId, '/base/mybase/compositions', {
      method: 'POST',
      body: JSON.stringify(compBody),
    }, {
      session,
      callerUserId: '00000000-0000-0000-0000-000000000000',
    });
    createdInfo = { status: c.status, body: c.json };
    if (c.status >= 200 && c.status < 300 && c.json && typeof c.json === 'object') {
      compositionId = (c.json as { id?: string }).id;
    }
    if (!compositionId) {
      return jsonResponse({ ok: false, error: 'createComposition falhou', details: createdInfo });
    }
    // Agora adiciona bases na composição: SINAPI/PI/02-2026
    const bRes = await orcafascioFetch(admin, credentialId, `/base/mybase/compositions/${compositionId}/add_bases`, {
      method: 'POST',
      body: JSON.stringify({
        bases: [{
          name: 'SINAPI',
          local: 'PI',
          version: '02/2026',
          status: true,
          with_labor_charges: false,
        }],
      }),
    }, {
      session,
      callerUserId: '00000000-0000-0000-0000-000000000000',
    });
    addBasesInfo = { status: bRes.status, body: bRes.json ?? bRes.rawText.slice(0, 300) };
  }

  // Variações pra testar
  const tries: Array<{ label: string; method: string; path: string; body: unknown }> = [
    {
      label: 'A) /add-items {items:[{bank,code,qty,is_resource:true}]} (atual)',
      method: 'POST',
      path: `/base/mybase/compositions/${compositionId}/add-items`,
      body: { items: [{ bank, code, qty: 1, is_resource: true }] },
    },
    {
      label: 'B) /add-items {items:[{bank,code,qty,type:"resource"}]}',
      method: 'POST',
      path: `/base/mybase/compositions/${compositionId}/add-items`,
      body: { items: [{ bank, code, qty: 1, type: 'resource' }] },
    },
    {
      label: 'C) /add-items {items:[{bank,code,qty,kind:"resource"}]}',
      method: 'POST',
      path: `/base/mybase/compositions/${compositionId}/add-items`,
      body: { items: [{ bank, code, qty: 1, kind: 'resource' }] },
    },
    {
      label: 'D) /add-resources {resources:[{bank,code,qty}]}',
      method: 'POST',
      path: `/base/mybase/compositions/${compositionId}/add-resources`,
      body: { resources: [{ bank, code, qty: 1 }] },
    },
    {
      label: 'E) /add-items {items:[{bank,code,qty}]} (sem is_resource)',
      method: 'POST',
      path: `/base/mybase/compositions/${compositionId}/add-items`,
      body: { items: [{ bank, code, qty: 1 }] },
    },
    {
      label: 'F) /add-resources {items:[{bank,code,qty}]}',
      method: 'POST',
      path: `/base/mybase/compositions/${compositionId}/add-resources`,
      body: { items: [{ bank, code, qty: 1 }] },
    },
    {
      label: 'G) /add_resources (underscore) {items:[...]}',
      method: 'POST',
      path: `/base/mybase/compositions/${compositionId}/add_resources`,
      body: { items: [{ bank, code, qty: 1 }] },
    },
    {
      label: 'H) /add-items {items:[{bank,code,qty,is_resource:1}]} (number)',
      method: 'POST',
      path: `/base/mybase/compositions/${compositionId}/add-items`,
      body: { items: [{ bank, code, qty: 1, is_resource: 1 }] },
    },
    {
      label: 'I) /add-items is_resource:false (truque — manda como composição)',
      method: 'POST',
      path: `/base/mybase/compositions/${compositionId}/add-items`,
      body: { items: [{ bank, code, qty: 1, is_resource: false }] },
    },
    {
      label: 'J) /add-items items NESTED em resources_items',
      method: 'POST',
      path: `/base/mybase/compositions/${compositionId}/add-items`,
      body: { items: [{ bank, code, qty: 1, item_kind: 'resource' }] },
    },
    {
      label: 'K) PUT /v1/base/mybase/compositions/{id}/insumos',
      method: 'POST',
      path: `/base/mybase/compositions/${compositionId}/insumos`,
      body: { insumos: [{ bank, code, qty: 1 }] },
    },
    {
      label: 'L) /add-items {items:[{bank:"MYBASE",code,qty,type:"resource"}]} (force MyBase)',
      method: 'POST',
      path: `/base/mybase/compositions/${compositionId}/add-items`,
      body: { items: [{ bank: 'MYBASE', code, qty: 1, type: 'resource' }] },
    },
    {
      label: 'M) /add-items type:resource + state:PI',
      method: 'POST',
      path: `/base/mybase/compositions/${compositionId}/add-items`,
      body: { items: [{ bank, code, qty: 1, type: 'resource', state: 'PI' }] },
    },
    {
      label: 'N) /add-items bank:MYBASE com type:composition',
      method: 'POST',
      path: `/base/mybase/compositions/${compositionId}/add-items`,
      body: { items: [{ bank: 'MYBASE', code, qty: 1, type: 'composition' }] },
    },
    {
      label: 'O) /add-items bank:MYBASE com type:emp_resource',
      method: 'POST',
      path: `/base/mybase/compositions/${compositionId}/add-items`,
      body: { items: [{ bank: 'MYBASE', code, qty: 1, type: 'emp_resource' }] },
    },
    {
      label: 'P) /add-items bank:EMP (vez de MYBASE) com type:resource',
      method: 'POST',
      path: `/base/mybase/compositions/${compositionId}/add-items`,
      body: { items: [{ bank: 'EMP', code, qty: 1, type: 'resource' }] },
    },
    {
      label: 'Q) PUT na composição com items[] inline',
      method: 'PUT',
      path: `/base/mybase/compositions/${compositionId}`,
      body: { items: [{ bank, code, qty: 1, type: 'resource' }] },
    },
    {
      label: 'R) /add-items com code+banco mas SEM type/is_resource',
      method: 'POST',
      path: `/base/mybase/compositions/${compositionId}/add-items`,
      body: { items: [{ bank: 'MYBASE', code, qty: 1 }] },
    },
    // ===== Variações pra configurar BANKS (data-base) na composição =====
    {
      label: 'B1) POST /update-banks {banks:{SINAPI:{...}}}',
      method: 'POST',
      path: `/base/mybase/compositions/${compositionId}/update-banks`,
      body: { banks: { SINAPI: { data: '02/2026', estado: 'PI', relatorio: true } } },
    },
    {
      label: 'B2) PATCH /base/mybase/compositions/{id} {banks:{...}}',
      method: 'PATCH',
      path: `/base/mybase/compositions/${compositionId}`,
      body: { banks: { SINAPI: { data: '02/2026', estado: 'PI', relatorio: true } } },
    },
    {
      label: 'B3) PUT /base/mybase/compositions/{id} {banks:{...}}',
      method: 'PUT',
      path: `/base/mybase/compositions/${compositionId}`,
      body: { banks: { SINAPI: { data: '02/2026', estado: 'PI', relatorio: true } } },
    },
    {
      label: 'B4) POST /update-bases {bases:[...]} (estilo orçamento)',
      method: 'POST',
      path: `/base/mybase/compositions/${compositionId}/update-bases`,
      body: { bases: [{ name: 'SINAPI', local: 'PI', version: '02/2026', status: true }] },
    },
    {
      label: 'B5) POST /add-bases {bases:[...]} (estilo helper antigo)',
      method: 'POST',
      path: `/base/mybase/compositions/${compositionId}/add-bases`,
      body: { bases: [{ name: 'SINAPI', local: 'PI', version: '02/2026', status: true }] },
    },
    {
      label: 'B6) POST /add_bases (underscore) {bases:[...]}',
      method: 'POST',
      path: `/base/mybase/compositions/${compositionId}/add_bases`,
      body: { bases: [{ name: 'SINAPI', local: 'PI', version: '02/2026', status: true }] },
    },
    {
      label: 'B7) PATCH /base/mybase/compositions/{id} {SINAPI:{data,estado}} flat',
      method: 'PATCH',
      path: `/base/mybase/compositions/${compositionId}`,
      body: { SINAPI: { data: '02/2026', estado: 'PI' } },
    },
  ];

  const results: Array<{ label: string; status: number; bodySnippet: string }> = [];
  for (const t of tries) {
    try {
      const r = await orcafascioFetch(admin, credentialId, t.path, {
        method: t.method,
        body: JSON.stringify(t.body),
      }, {
        session,
        callerUserId: '00000000-0000-0000-0000-000000000000',
      });
      const snippet = typeof r.json === 'object'
        ? JSON.stringify(r.json).slice(0, 200)
        : r.rawText.slice(0, 200);
      results.push({ label: t.label, status: r.status, bodySnippet: snippet });
    } catch (e) {
      results.push({
        label: t.label,
        status: -1,
        bodySnippet: e instanceof Error ? e.message.slice(0, 200) : String(e),
      });
    }
  }

  return jsonResponse({ ok: true, composition_id: compositionId, created: createdInfo, addBases: addBasesInfo, sample: { bank, code }, results });
});
