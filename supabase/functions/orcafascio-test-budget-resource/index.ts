// =============================================================================
// Edge Function: orcafascio-test-budget-resource (TEMP — diagnóstico)
// =============================================================================
// Testa variações de payload pra adicionar item ao ORÇAMENTO (não composição)
// como Resource MyBase direto, garantindo preço fixo do edital.
//
// Body: { credential_id_web, budget_id, resource_code, resource_id }
// =============================================================================

import { handleCorsPreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/json.ts';
import { getServiceRoleClient } from '../_shared/supabase.ts';
import { authenticateOrcafascioWeb } from '../_shared/orcafascio-web.ts';
import { createContext, uuidv4 } from '../_shared/orcafascio-web-v2023.ts';

interface RequestBody {
  credential_id_web?: string;
  budget_id?: string;
  resource_code?: string;
  resource_id?: string;
}

const BASE = 'https://app.orcafascio.com';

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;

  let body: RequestBody;
  try { body = await req.json(); } catch { return errorResponse(400, 'JSON inválido.'); }

  const credId = body.credential_id_web?.trim();
  const budgetId = body.budget_id?.trim();
  const code = body.resource_code?.trim();
  const resId = body.resource_id?.trim();
  if (!credId || !budgetId || !code || !resId) {
    return errorResponse(400, 'credential_id_web, budget_id, resource_code, resource_id obrigatórios.');
  }

  const admin = getServiceRoleClient();
  const session = await authenticateOrcafascioWeb(admin, credId, {
    callerUserId: '00000000-0000-0000-0000-000000000000',
    traceId: crypto.randomUUID(),
  });
  const ctx = await createContext(admin, session, credId, '00000000-0000-0000-0000-000000000000', null, undefined,
    () => authenticateOrcafascioWeb(admin, credId, {
      callerUserId: '00000000-0000-0000-0000-000000000000',
      forceRefresh: true,
    }),
  );

  // Variações pra adicionar resource ao orçamento
  const tries = [
    {
      label: 'A) kind:resource bank:MYBASE',
      fields: {
        'new_items[0][kind]': 'resource',
        'new_items[0][itemization]': '99.1',
        'new_items[0][qty]': '1',
        'new_items[0][base]': 'MYBASE',
        'new_items[0][base_id]': uuidv4(),
        'new_items[0][public_banco_id]': resId,
        'new_items[0][code]': code,
      },
    },
    {
      label: 'B) kind:insumo bank:MYBASE',
      fields: {
        'new_items[0][kind]': 'insumo',
        'new_items[0][itemization]': '99.2',
        'new_items[0][qty]': '1',
        'new_items[0][base]': 'MYBASE',
        'new_items[0][base_id]': uuidv4(),
        'new_items[0][public_banco_id]': resId,
        'new_items[0][code]': code,
      },
    },
    {
      label: 'C) kind:composition + is_resource:true (pra orçamento)',
      fields: {
        'new_items[0][kind]': 'composition',
        'new_items[0][itemization]': '99.3',
        'new_items[0][qty]': '1',
        'new_items[0][base]': 'MYBASE',
        'new_items[0][base_id]': uuidv4(),
        'new_items[0][public_banco_id]': resId,
        'new_items[0][code]': code,
        'new_items[0][is_resource]': 'true',
      },
    },
    {
      label: 'D) kind:composition (atual, manda como composition)',
      fields: {
        'new_items[0][kind]': 'composition',
        'new_items[0][itemization]': '99.4',
        'new_items[0][qty]': '1',
        'new_items[0][base]': 'MYBASE',
        'new_items[0][base_id]': uuidv4(),
        'new_items[0][public_banco_id]': resId,
        'new_items[0][code]': code,
      },
    },
  ];

  const results: Array<{ label: string; status: number; response: string }> = [];
  for (const t of tries) {
    const data = new URLSearchParams({
      utf8: '✓',
      authenticity_token: ctx.csrfToken,
      ...t.fields,
    });
    const r = await fetch(`${BASE}/v2023/bud/budgets/${budgetId}/items/`, {
      method: 'POST',
      headers: {
        Cookie: ctx.session.cookie_header,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/html, */*',
        'User-Agent': 'pavcon-test',
      },
      body: data.toString(),
      redirect: 'manual',
    });
    const respText = (await r.text()).slice(0, 400);
    results.push({ label: t.label, status: r.status, response: respText });
  }

  return jsonResponse({ ok: true, results });
});
