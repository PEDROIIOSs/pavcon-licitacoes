// =============================================================================
// Edge Function: orcafascio-sync-grupos
// =============================================================================
// Sincroniza pastas/grupos do MyBase do Orçafascio para
// `orcafascio_grupos_cache`. Pensado pra rodar:
//   - on-demand (via UI: "Atualizar grupos")
//   - agendado (Postgres pg_cron) pra manter o cache fresco
//
// Body (JSON):
//   {
//     "credential_id": "uuid",       // obrigatório
//     "trace_id": "uuid"             // opcional
//   }
//
// Resposta 200:
//   {
//     "fetched": 12,                 // grupos retornados pelo Orçafascio
//     "upserted": 12,                // gravados no cache
//     "removed": 0,                  // grupos sumiram do Orçafascio e foram apagados
//     "trace_id": "..."
//   }
// =============================================================================

import { handleCorsPreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/json.ts';
import {
  getServiceRoleClient,
  HttpError,
  requireAuthenticatedUser,
} from '../_shared/supabase.ts';
import {
  authenticateOrcafascio,
  OrcafascioAuthError,
  orcafascioFetch,
} from '../_shared/orcafascio.ts';

interface RequestBody {
  credential_id?: string;
  trace_id?: string;
}

interface OrcafascioGroup {
  // Estrutura inferida (Mongo ObjectIds). Ajustar se primeira chamada divergir.
  _id?: string;
  id?: string;
  description?: string;
  name?: string;
  company_id?: string;
  company?: { _id?: string; id?: string };
  department_id?: string;
  department?: { _id?: string; id?: string };
  user_id?: string;
  user?: { _id?: string; id?: string };
  inserted_at?: string;
  created_at?: string;
}

interface GroupsResponse {
  data?: OrcafascioGroup[];
  groups?: OrcafascioGroup[];
  results?: OrcafascioGroup[];
  [key: string]: unknown;
}

function pick<T>(...candidates: Array<T | undefined>): T | undefined {
  for (const c of candidates) {
    if (c !== undefined && c !== null && c !== '') return c;
  }
  return undefined;
}

function extractGroupsArray(payload: unknown): OrcafascioGroup[] {
  if (Array.isArray(payload)) return payload as OrcafascioGroup[];
  if (payload && typeof payload === 'object') {
    const obj = payload as GroupsResponse;
    return obj.data ?? obj.groups ?? obj.results ?? [];
  }
  return [];
}

const ERR_TO_HTTP: Record<OrcafascioAuthError['code'], number> = {
  credential_not_found: 404,
  credential_inactive: 403,
  credential_wrong_provider: 400,
  credential_no_email: 422,
  vault_unreadable: 500,
  orcafascio_rejected: 422,
  orcafascio_unreachable: 502,
  orcafascio_unexpected: 502,
};

Deno.serve(async (req: Request) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return errorResponse(405, 'Método não permitido. Use POST.');
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, 'JSON inválido no body.');
  }

  const credentialId = body.credential_id?.trim();
  if (!credentialId) {
    return errorResponse(400, 'credential_id é obrigatório.');
  }

  const traceId = body.trace_id ?? crypto.randomUUID();
  const admin = getServiceRoleClient();

  try {
    const user = await requireAuthenticatedUser(req);

    // 1) Garantir token válido
    const session = await authenticateOrcafascio(admin, credentialId, {
      callerUserId: user.id,
      traceId,
    });

    // 2) Buscar grupos do Orçafascio
    let result = await orcafascioFetch(admin, credentialId, '/base/mybase/groups', {
      method: 'GET',
    }, { session, callerUserId: user.id, traceId });

    // Auto-relogin em caso de 401 (token expirado por outro motivo)
    if (result.status === 401) {
      const fresh = await authenticateOrcafascio(admin, credentialId, {
        callerUserId: user.id,
        forceRefresh: true,
        traceId,
      });
      result = await orcafascioFetch(admin, credentialId, '/base/mybase/groups', {
        method: 'GET',
      }, { session: fresh, callerUserId: user.id, traceId });
    }

    if (result.status < 200 || result.status >= 300) {
      return errorResponse(
        502,
        `Orçafascio respondeu ${result.status} ao listar grupos.`,
        result.json ?? null,
      );
    }

    const groups = extractGroupsArray(result.json);

    // 3) Upsert cada grupo
    const rows = groups
      .map((g) => {
        const id = pick(g._id, g.id);
        const description = pick(g.description, g.name);
        if (!id || !description) return null;
        return {
          id,
          description,
          company_id: pick(g.company_id, g.company?._id, g.company?.id) ??
            session.orcafascio_company_id,
          department_id: pick(
            g.department_id,
            g.department?._id,
            g.department?.id,
          ) ?? session.orcafascio_department_id ?? null,
          user_id: pick(g.user_id, g.user?._id, g.user?.id) ??
            session.orcafascio_user_id,
          data_criacao_orcafascio: g.inserted_at ?? g.created_at ?? null,
          sincronizado_em: new Date().toISOString(),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    let upserted = 0;
    if (rows.length > 0) {
      const { error: upsertErr, count } = await admin
        .from('orcafascio_grupos_cache')
        .upsert(rows, { onConflict: 'id', count: 'exact' });
      if (upsertErr) {
        console.error('[orcafascio-sync-grupos] upsert falhou:', upsertErr);
        return errorResponse(500, 'Falha ao gravar cache de grupos.', upsertErr.message);
      }
      upserted = count ?? rows.length;
    }

    // 4) Remover grupos que sumiram do Orçafascio
    const ids = rows.map((r) => r.id);
    let removed = 0;
    if (ids.length > 0) {
      const { error: delErr, count } = await admin
        .from('orcafascio_grupos_cache')
        .delete({ count: 'exact' })
        .not('id', 'in', `(${ids.map((i) => `"${i}"`).join(',')})`);
      if (delErr) {
        console.warn('[orcafascio-sync-grupos] delete stale falhou:', delErr);
      } else {
        removed = count ?? 0;
      }
    }

    return jsonResponse({
      fetched: groups.length,
      upserted,
      removed,
      trace_id: traceId,
    });
  } catch (err) {
    if (err instanceof OrcafascioAuthError) {
      return errorResponse(ERR_TO_HTTP[err.code], err.message, err.details);
    }
    if (err instanceof HttpError) {
      return errorResponse(err.status, err.message, err.details);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[orcafascio-sync-grupos] erro inesperado:', err);
    return errorResponse(500, 'Erro inesperado.', msg);
  }
});
