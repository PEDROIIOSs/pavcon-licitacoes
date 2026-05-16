// Helpers pra API interna /v2023/ do Orçafascio (cookie-based auth).
// Reverse-engineering documentado em docs/orcafascio-v2023-api.md.
// USAR COM CUIDADO: endpoints não-oficiais, podem mudar sem aviso.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { logIntegration } from './audit.ts';
import type { OrcafascioWebSession } from './orcafascio-web.ts';

const BASE = 'https://app.orcafascio.com';

// =============================================================================
// Tipos
// =============================================================================

export interface BudgetCreateInput {
  /** Curto pra appearance na listagem (ex.: nome do município) */
  codigo: string;
  /** Descrição completa do orçamento (ex.: título da licitação) */
  descricao: string;
  /** ID do cliente — opcional */
  cliente_id?: string;
  /** Categoria padrão (ex.: "Infraestruturas Esportivas - Reforma") */
  standard_category_name?: string;
  custom_category_name?: string;
  validity?: string;
  /** Permite insumos com preço zerado (default true) */
  insumos_zerados?: boolean;
  /** Auto-itemização (default true — Versão 2023) */
  version_2023?: boolean;
  mask_itemization?: boolean;
  /** Marca o orçamento como vinculado a licitação */
  licitacao?: boolean;
  /** 1=arredondar, 2=truncar 2 casas, 0=sem arredondamento */
  rounding_option?: 1 | 2 | 0;
}

export interface BudgetItemPhase {
  kind: 'phase';
  itemization: string;
  descr: string;
  parent_descr?: string;
  qty?: number;
}

export interface BudgetItemComposition {
  kind: 'composition';
  itemization: string;
  /** Banco fonte: SINAPI | SBC | SICRO | ORSE | SEINFRA | MYBASE */
  base: string;
  /** UUID gerado client-side (v4) */
  base_id: string;
  /** ID público da MyBase (quando base=MYBASE) */
  public_banco_id?: string;
  /** Código no banco (ex.: 88316 SINAPI, EDIT.PICOS.1.1 MyBase) */
  code: string;
  qty: number;
}

export type BudgetItem = BudgetItemPhase | BudgetItemComposition;

export interface BasesInput {
  atualizar_composicoes?: boolean;
  /** Cada banco. `estado` é opcional — só pra bancos com select de estado
   * no form (SINAPI/SBC/SICRO3/SETOP/EMBASA). Outros (ORSE/SEINFRA/etc.)
   * têm estado implícito; passar `estado` causa 500 no Orçafascio.
   * `nome` é o ID exato no form (incluindo 'SICRO3' com o 3, não 'SICRO'). */
  bancos: Array<{
    nome: string;
    estado?: string;    // UF (só pra bancos com select de estado)
    data: string;       // mm/aaaa ex.: "03/2026"
    exibir_relatorio?: boolean;
    rounding_option?: number;
  }>;
}

export interface BdiInput {
  /** Aplica BDI no preço final (true) ou no unitário (false). Default true. */
  no_final?: boolean;
  /** Percentual do BDI (ex.: 22.0) */
  bdi_manual: number;
  base_bdi?: number;
}

export interface LeisSociaisInput {
  /** false = não desonerado (default pra obras públicas com encargos embutidos) */
  desonerado?: boolean;
  charge_manual?: boolean;
  charge_hourly?: number;   // 113.78 típico não-desonerado
  charge_monthly?: number;
  horista?: number;
  mensalista?: number;
}

export class OrcafascioV2023Error extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
    public readonly endpoint?: string,
  ) {
    super(message);
    this.name = 'OrcafascioV2023Error';
  }
}

// =============================================================================
// CSRF
// =============================================================================

/** Busca o authenticity_token (CSRF do Rails) a partir do meta tag da página. */
export async function fetchCsrfToken(session: OrcafascioWebSession): Promise<string> {
  const r = await fetch(`${BASE}/orc/orcamentos/new`, {
    method: 'GET',
    headers: {
      Cookie: session.cookie_header,
      'User-Agent': 'pavcon-licitacoes/0.1 (Edge Function)',
      Accept: 'text/html',
    },
    redirect: 'manual',
  });
  const html = await r.text();
  const m = html.match(/<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i);
  if (!m) {
    throw new OrcafascioV2023Error(
      r.status,
      'CSRF token não encontrado em /orc/orcamentos/new',
      { status: r.status, body_excerpt: html.slice(0, 300) },
    );
  }
  return m[1];
}

// =============================================================================
// Fetch genérico v2023 (form-urlencoded + cookie + audit log)
// =============================================================================

interface OpContext {
  admin: SupabaseClient;
  session: OrcafascioWebSession;
  credentialId: string;
  callerUserId: string;
  csrfToken: string;
  licitacaoId?: string | null;
  traceId?: string;
}

async function postForm<T = unknown>(
  ctx: OpContext,
  path: string,
  formData: Record<string, string>,
  endpointLabel: string,
): Promise<T> {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const startedAt = Date.now();

  // Rails espera `utf8=✓` (force-encoding marker) E o authenticity_token.
  // Sem o utf8, alguns controllers (incl. update_bases) retornam 500 silencioso.
  const body = new URLSearchParams({
    utf8: '✓',
    authenticity_token: ctx.csrfToken,
    ...formData,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Cookie: ctx.session.cookie_header,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/vnd.api+json, application/json, text/html, */*',
      Origin: BASE,
      Referer: `${BASE}/orc/orcamentos`,
      'User-Agent': 'pavcon-licitacoes/0.1 (Edge Function)',
    },
    body: body.toString(),
    redirect: 'manual',
  });

  const rawText = await response.text();
  let json: unknown = null;
  try {
    json = rawText ? JSON.parse(rawText) : null;
  } catch {
    json = null;
  }

  await logIntegration(ctx.admin, {
    user_id: ctx.callerUserId,
    licitacao_id: ctx.licitacaoId ?? null,
    provider: 'orcafascio',
    endpoint: url,
    metodo_http: 'POST',
    request_payload: {
      // Não loga body completo — pode ter dados sensíveis. Só nomes dos campos.
      field_names: Object.keys(formData),
      n_fields: Object.keys(formData).length,
    },
    response_status: response.status,
    response_payload: json ?? { raw: rawText.slice(0, 500) },
    duracao_ms: Date.now() - startedAt,
    trace_id: ctx.traceId ?? null,
  });

  // 302 com Location é normal (Rails redirect after create)
  if (response.status === 302 || response.status === 303) {
    const location = response.headers.get('location');
    return { __redirect: location } as T;
  }
  if (response.status < 200 || response.status >= 300) {
    throw new OrcafascioV2023Error(
      response.status,
      `${endpointLabel} respondeu ${response.status}.`,
      json ?? rawText.slice(0, 500),
      url,
    );
  }
  return (json ?? { raw: rawText }) as T;
}

// =============================================================================
// Endpoints
// =============================================================================

/** Cria um novo orçamento. Retorna o budget_id extraído do redirect. */
export async function createBudget(
  ctx: OpContext,
  input: BudgetCreateInput,
): Promise<{ budget_id: string }> {
  const data: Record<string, string> = {
    'orc_orcamento[codigo]': input.codigo,
    'orc_orcamento[descricao]': input.descricao,
    'orc_orcamento[cliente_id]': input.cliente_id ?? '',
    'orc_orcamento[standard_category_name]': input.standard_category_name ?? '',
    'orc_orcamento[custom_category_name]': input.custom_category_name ?? '',
    'orc_orcamento[validity]': input.validity ?? '',
    'orc_orcamento[insumos_zerados]': input.insumos_zerados !== false ? '1' : '0',
    'orc_orcamento[version_2023]': input.version_2023 !== false ? '1' : '0',
    'orc_orcamento[mask_itemization]': input.mask_itemization !== false ? '1' : '0',
    'orc_orcamento[licitacao]': input.licitacao ? '1' : '0',
    'orc_orcamento[rounding_option]': String(input.rounding_option ?? 1),
  };

  const result = await postForm<{ __redirect?: string | null }>(
    ctx,
    '/orc/orcamentos',
    data,
    'createBudget',
  );

  // Resposta esperada: 302 → /orc/orcamentos/{id}/new_passo_2
  const loc = result.__redirect ?? '';
  const m = loc.match(/\/orc\/orcamentos\/([a-f0-9]{24})/);
  if (!m) {
    throw new OrcafascioV2023Error(
      0,
      'createBudget: não consegui extrair budget_id do redirect',
      { redirect: loc, result },
    );
  }
  return { budget_id: m[1] };
}

/** Atualiza BDI do orçamento. */
export async function updateBdi(
  ctx: OpContext,
  budgetId: string,
  input: BdiInput,
): Promise<void> {
  await postForm(
    ctx,
    `/v2023/orc/orcamentos/update_bdi?id=${budgetId}`,
    {
      no_final: input.no_final !== false ? '1' : '0',
      bdi_manual: String(input.bdi_manual),
      base_bdi: String(input.base_bdi ?? input.bdi_manual),
    },
    'updateBdi',
  );
}

/** Atualiza leis sociais (encargos) do orçamento. */
export async function updateLeisSociais(
  ctx: OpContext,
  budgetId: string,
  input: LeisSociaisInput,
): Promise<void> {
  await postForm(
    ctx,
    `/v2023/orc/orcamentos/update_leis_sociais?id=${budgetId}`,
    {
      desonerado: input.desonerado ? '1' : '0',
      charge_manual: input.charge_manual ? '1' : '0',
      charge_hourly: String(input.charge_hourly ?? 113.78),
      charge_monthly: String(input.charge_monthly ?? 71.59),
      horista: String(input.horista ?? input.charge_hourly ?? 113.78),
      mensalista: String(input.mensalista ?? input.charge_monthly ?? 71.59),
    },
    'updateLeisSociais',
  );
}

/** Lê o form de bases (GET na página do orçamento) e devolve o valor padrão
 * (option SELECTED ou primeira option) de cada `{banco}_data` e `{banco}_estado`.
 * É preciso enviar o form COMPLETO pra updateBases — mandar só alguns campos
 * faz o Rails crashar com 500 (controller itera sobre todos os bancos
 * conhecidos e quebra se faltar param). */
async function fetchBasesFormDefaults(
  ctx: OpContext,
  budgetId: string,
): Promise<{ banks: string[]; defaults: Record<string, { data?: string; estado?: string }> }> {
  const r = await fetch(`${BASE}/orc/orcamentos/${budgetId}`, {
    method: 'GET',
    headers: {
      Cookie: ctx.session.cookie_header,
      'User-Agent': 'pavcon-licitacoes/0.1 (Edge Function)',
      Accept: 'text/html',
    },
    redirect: 'manual',
  });
  const html = await r.text();
  // Extrai o form id="my_form" (form de bases)
  const m = html.match(/<form\s+id="my_form"[\s\S]*?<\/form>/);
  if (!m) {
    throw new OrcafascioV2023Error(
      r.status,
      'Form id="my_form" não encontrado na página do orçamento — não dá pra ler defaults dos bancos.',
      { excerpt: html.slice(0, 300) },
    );
  }
  const form = m[0];
  const banks = new Set<string>();
  const defaults: Record<string, { data?: string; estado?: string }> = {};
  // Itera por cada <select name="{algo}_data" ou {algo}_estado">
  const selectRe = /<select[^>]+name="([^"]+?)_(data|estado)"[^>]*>([\s\S]*?)<\/select>/g;
  let sm: RegExpExecArray | null;
  while ((sm = selectRe.exec(form)) !== null) {
    const bank = sm[1];
    const field = sm[2] as 'data' | 'estado';
    const optionsHtml = sm[3];
    // Pega option com selected, senão o primeiro
    const selectedMatch = optionsHtml.match(/<option[^>]*value="([^"]+)"[^>]*selected/);
    const firstMatch = optionsHtml.match(/<option[^>]*value="([^"]+)"/);
    const value = selectedMatch?.[1] ?? firstMatch?.[1];
    if (!value) continue;
    banks.add(bank);
    if (!defaults[bank]) defaults[bank] = {};
    defaults[bank][field] = value;
  }
  // Tambem coleta nomes dos bancos via checkboxes (caso algum banco só tenha relatorio)
  const cbRe = /<input[^>]+type="checkbox"[^>]+name="([^"]+?)_exibir_relatorio"/g;
  while ((sm = cbRe.exec(form)) !== null) {
    banks.add(sm[1]);
  }
  return { banks: Array.from(banks), defaults };
}

/** Atualiza bases (bancos de referência: SINAPI/SICRO3/ORSE/...).
 * Faz GET no orçamento pra ler defaults de todos os bancos, e MERGE com
 * os overrides em `input.bancos`. Submete o form COMPLETO (~70 campos) —
 * Orçafascio retorna 500 se receber só parte dos bancos. */
export async function updateBases(
  ctx: OpContext,
  budgetId: string,
  input: BasesInput,
): Promise<void> {
  const { banks: allBanks, defaults } = await fetchBasesFormDefaults(ctx, budgetId);

  const overridesByName = new Map<string, BasesInput['bancos'][number]>();
  for (const b of input.bancos) overridesByName.set(b.nome, b);

  const data: Record<string, string> = {
    // Radio com valor JSON-stringified (não 1/0). Default: atualiza tudo.
    atualizar_composicoes: input.atualizar_composicoes !== false
      ? '{"atualizar_comp":true,"atualizar_ins":true}'
      : '{"atualizar_comp":false,"atualizar_ins":false}',
  };
  for (const bank of allBanks) {
    const override = overridesByName.get(bank);
    const def = defaults[bank] ?? {};
    // exibir_relatorio: true pros bancos que o user pediu, false pros outros
    data[`${bank}_exibir_relatorio`] = override
      ? override.exibir_relatorio !== false ? 'true' : 'false'
      : 'false';
    // estado: usa override se tiver, senão default do form (só se o select existe)
    const estado = override?.estado ?? def.estado;
    if (estado) data[`${bank}_estado`] = estado;
    // data: usa override se tiver, senão default do form
    const dataValue = override?.data ?? def.data;
    if (dataValue) data[`${bank}_data`] = dataValue;
    if (override?.rounding_option != null) {
      data[`${bank}_rounding_option`] = String(override.rounding_option);
    }
  }

  await postForm(
    ctx,
    `/v2023/bud/budgets/${budgetId}/update_bases`,
    data,
    'updateBases',
  );
}

/**
 * Adiciona N itens (etapas, sub-etapas, composições) ao orçamento numa
 * única request. CHAVE pra performance — em vez de N round-trips, manda tudo
 * de uma vez.
 */
export async function addItemsBatch(
  ctx: OpContext,
  budgetId: string,
  items: BudgetItem[],
): Promise<void> {
  if (items.length === 0) return;
  const data: Record<string, string> = {};
  items.forEach((it, idx) => {
    const p = `new_items[${idx}]`;
    data[`${p}[kind]`] = it.kind;
    data[`${p}[itemization]`] = it.itemization;
    data[`${p}[qty]`] = String(it.qty ?? 1);
    if (it.kind === 'phase') {
      data[`${p}[descr]`] = it.descr;
      data[`${p}[parent_descr]`] = it.parent_descr ?? '';
    } else {
      // composition
      data[`${p}[base]`] = it.base;
      data[`${p}[base_id]`] = it.base_id;
      data[`${p}[public_banco_id]`] = it.public_banco_id ?? '';
      data[`${p}[code]`] = it.code;
    }
  });
  await postForm(
    ctx,
    `/v2023/bud/budgets/${budgetId}/items/`,
    data,
    `addItemsBatch(${items.length})`,
  );
}

// =============================================================================
// Helpers
// =============================================================================

/** Gera UUID v4 — usado pra preencher base_id de itens novos */
export function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Mapeia fonte do edital pro `base` esperado pela API v2023. */
export function fonteToBase(fonte: string | null | undefined): string {
  if (!fonte) return 'OUTRA';
  const f = fonte.toUpperCase();
  if (['SINAPI', 'SBC', 'SICRO', 'ORSE', 'SEINFRA', 'FDE', 'SUDECAP'].includes(f)) return f;
  if (f === 'PROPRIA') return 'MYBASE';
  return 'OUTRA';
}

/**
 * Cria o OpContext (utilitário). Use isso depois de autenticar.
 */
export async function createContext(
  admin: SupabaseClient,
  session: OrcafascioWebSession,
  credentialId: string,
  callerUserId: string,
  licitacaoId?: string | null,
  traceId?: string,
): Promise<OpContext> {
  const csrfToken = await fetchCsrfToken(session);
  return { admin, session, credentialId, callerUserId, csrfToken, licitacaoId, traceId };
}
