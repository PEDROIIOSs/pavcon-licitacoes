// Helpers tipados para os endpoints CRUD do MyBase do Orçafascio.
// Baseado na documentação oficial em https://orcafascio.apidog.io/
//
// Cobre: groups, resources, compositions, composition items, bases.
// NÃO cobre criação de orçamento (não existe endpoint público — Bloqueio
// conhecido confirmado pela ausência nos docs).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import {
  orcafascioFetch,
  type OrcafascioSession,
} from './orcafascio.ts';

// =============================================================================
// Tipos do domínio Orçafascio
// =============================================================================

/** Códigos de tipo pra Resource (insumo) — vide type-and-unit-catalog dos docs */
export const RESOURCE_TYPE = {
  EQUIPAMENTO: 1,
  EQUIPAMENTO_PERMANENTE: 2,
  MAO_DE_OBRA: 3,
  MATERIAL: 4,
  SERVICOS: 5,
  TAXAS: 6,
  OUTROS: 7,
  FRANQUIA: 8,
  ADMINISTRACAO: 9,
  ALUGUEL: 10,
  VERBA: 11,
  CONSULTORIA: 12,
  TRANSPORTE: 13,
  FATURAMENTO_DIRETO: 101,
} as const;

/** Métodos de cálculo (rounding_type) pra Composition */
export const ROUNDING_TYPE = {
  ARREDONDAR: 1,
  TRUNCAR_2_CASAS: 2,
  TRUNCAR_4_CASAS: 3,
  SEM_ARREDONDAMENTO: 4,
} as const;

// Tipos comuns das composições (catalog parcial — completar conforme necessidade)
// Pra "PROPRIA" geralmente usamos OUTR ou um dos genéricos
export const COMPOSITION_TYPES = [
  'ASTU', 'CANT', 'COBE', 'CHOR', 'DROP', 'ESCO', 'ESQV', 'FOMA', 'FUES',
  'IMPE', 'INEL', 'INPR', 'INES', 'INHI', 'LIPR', 'MOVT', 'PARE', 'PAVI',
  'PINT', 'PISO', 'REVE', 'SEDI', 'SEEM', 'SEES', 'SEOP', 'SERP', 'SERT',
  'TRAN', 'URBA',
] as const;

export interface GroupRecord {
  id: string;
  company_id: string;
  user_id: string;
  department_id: string;
  description: string;
  created_at: string;
}

export interface ResourceRecord {
  id: string;
  company_id: string;
  user_id: string;
  department_id: string;
  group_id: string | null;
  code: string;
  second_code: string;
  description: string;
  type: number;
  unit: string;
  locals?: Record<string, { pnd?: number; pd?: number; pndi?: number; pdi?: number }>;
  status: boolean;
  note: string;
}

export interface CompositionRecord {
  id: string;
  company_id: string;
  user_id: string;
  department_id: string;
  code: string;
  second_code: string;
  description: string;
  type: string;
  unit: string;
  state: string;
  is_sicro: boolean;
  labor: boolean;
  calculation_method?: { type: number; description: string };
  prices?: { pnd?: number; pd?: number };
  banks?: Record<string, unknown>;
  items?: Array<{
    code: string;
    bank: string;
    qty: number;
    description?: string;
  }>;
  created_at: string;
}

// =============================================================================
// Body inputs (tipados a partir da documentação)
// =============================================================================

export interface CreateGroupInput {
  description: string;
}

export interface CreateResourceInput {
  group_id: string;
  code: string;
  second_code?: string;
  description: string;
  type: number;              // RESOURCE_TYPE.*
  unit: string;
  local: string;             // UF: "SP", "PI", etc.
  pnd: number;               // preço não desonerado operativo
  pd: number;                // preço desonerado operativo
  pndi: number;              // preço não desonerado improdutivo
  pdi: number;               // preço desonerado improdutivo
  status?: boolean;          // default true
  note?: string;
}

export interface CreateCompositionInput {
  code: string;
  second_code?: string;
  description: string;
  labor: boolean;
  type: string;              // COMPOSITION_TYPES[] (ex.: "PARE")
  unit: string;
  local: string;             // UF
  rounding_type: number;     // ROUNDING_TYPE.*
  is_sicro: boolean;         // false p/ modelo SINAPI, true p/ SICRO
  note?: string;
  // Campos SICRO-only (passar só quando is_sicro=true)
  team_production?: string;
  fic?: string;
  adc_labor?: string;
}

export interface CompositionItem {
  bank: string;              // "SINAPI" | "SBC" | "SICRO" | "ORSE" | ...
  code: string;              // Código do insumo no banco
  qty: number;               // Coeficiente
}

export interface AddItemsInput {
  items: CompositionItem[];
}

// =============================================================================
// Functions
// =============================================================================

interface OpContext {
  admin: SupabaseClient;
  session: OrcafascioSession;
  credentialId: string;
  callerUserId: string;
  licitacaoId?: string | null;
  traceId?: string;
}

export class OrcafascioApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
    public readonly endpoint?: string,
  ) {
    super(message);
    this.name = 'OrcafascioApiError';
  }
}

async function expectOk<T>(
  ctx: OpContext,
  method: string,
  path: string,
  body: unknown | null,
  endpointLabel: string,
): Promise<T> {
  const result = await orcafascioFetch(ctx.admin, ctx.credentialId, path, {
    method,
    body: body != null ? JSON.stringify(body) : undefined,
  }, {
    session: ctx.session,
    callerUserId: ctx.callerUserId,
    licitacaoId: ctx.licitacaoId ?? null,
    traceId: ctx.traceId,
  });
  if (result.status < 200 || result.status >= 300) {
    throw new OrcafascioApiError(
      result.status,
      `${endpointLabel} respondeu ${result.status}.`,
      result.json ?? result.rawText.slice(0, 500),
      `${method} ${path}`,
    );
  }
  return result.json as T;
}

// ----- Groups -----

export async function listGroups(
  ctx: OpContext,
  page = 1,
): Promise<{ total: number; records: GroupRecord[] }> {
  return await expectOk<{ total: number; records: GroupRecord[] }>(
    ctx,
    'GET',
    `/base/mybase/groups?page=${page}`,
    null,
    'listGroups',
  );
}

export async function createGroup(
  ctx: OpContext,
  input: CreateGroupInput,
): Promise<GroupRecord> {
  return await expectOk<GroupRecord>(
    ctx,
    'POST',
    '/base/mybase/groups',
    input,
    'createGroup',
  );
}

export async function getGroup(ctx: OpContext, id: string): Promise<GroupRecord> {
  return await expectOk<GroupRecord>(
    ctx,
    'GET',
    `/base/mybase/groups/${id}`,
    null,
    'getGroup',
  );
}

// ----- Resources -----

export async function listResources(
  ctx: OpContext,
  page = 1,
): Promise<{ total: number; records: ResourceRecord[] }> {
  return await expectOk(
    ctx,
    'GET',
    `/base/mybase/resources?page=${page}`,
    null,
    'listResources',
  );
}

export async function findResourceByCode(
  ctx: OpContext,
  code: string,
): Promise<ResourceRecord | null> {
  const result = await orcafascioFetch(
    ctx.admin,
    ctx.credentialId,
    `/resources/find_by_code?code=${encodeURIComponent(code)}`,
    { method: 'GET' },
    {
      session: ctx.session,
      callerUserId: ctx.callerUserId,
      licitacaoId: ctx.licitacaoId ?? null,
      traceId: ctx.traceId,
    },
  );
  if (result.status === 404) return null;
  if (result.status < 200 || result.status >= 300) {
    throw new OrcafascioApiError(
      result.status,
      `findResourceByCode falhou: ${result.status}.`,
      result.json,
    );
  }
  return result.json as ResourceRecord;
}

export async function createResource(
  ctx: OpContext,
  input: CreateResourceInput,
): Promise<ResourceRecord> {
  const body = {
    group_id: input.group_id,
    code: input.code,
    second_code: input.second_code ?? '',
    description: input.description,
    type: input.type,
    unit: input.unit,
    local: input.local,
    pnd: input.pnd,
    pd: input.pd,
    pndi: input.pndi,
    pdi: input.pdi,
    status: input.status ?? true,
    note: input.note ?? '',
  };
  return await expectOk<ResourceRecord>(
    ctx,
    'POST',
    '/base/mybase/resources',
    body,
    'createResource',
  );
}

export async function deleteResource(ctx: OpContext, id: string): Promise<void> {
  await expectOk(
    ctx,
    'DELETE',
    `/base/mybase/resources/${id}`,
    null,
    'deleteResource',
  );
}

// ----- Compositions -----

export async function listCompositions(
  ctx: OpContext,
  page = 1,
): Promise<{ total: number; records: CompositionRecord[] }> {
  return await expectOk(
    ctx,
    'GET',
    `/base/mybase/compositions?page=${page}`,
    null,
    'listCompositions',
  );
}

export async function findCompositionByCode(
  ctx: OpContext,
  code: string,
): Promise<CompositionRecord | null> {
  const result = await orcafascioFetch(
    ctx.admin,
    ctx.credentialId,
    `/base/mybase/compositions/find_by_code?code=${encodeURIComponent(code)}`,
    { method: 'GET' },
    {
      session: ctx.session,
      callerUserId: ctx.callerUserId,
      licitacaoId: ctx.licitacaoId ?? null,
      traceId: ctx.traceId,
    },
  );
  if (result.status === 404) return null;
  if (result.status < 200 || result.status >= 300) {
    throw new OrcafascioApiError(
      result.status,
      `findCompositionByCode falhou: ${result.status}.`,
      result.json,
    );
  }
  return result.json as CompositionRecord;
}

export async function getComposition(
  ctx: OpContext,
  id: string,
): Promise<CompositionRecord> {
  return await expectOk(
    ctx,
    'GET',
    `/base/mybase/compositions/${id}`,
    null,
    'getComposition',
  );
}

export async function createComposition(
  ctx: OpContext,
  input: CreateCompositionInput,
): Promise<CompositionRecord> {
  const body: Record<string, unknown> = {
    code: input.code,
    second_code: input.second_code ?? '',
    description: input.description,
    labor: input.labor,
    type: input.type,
    unit: input.unit,
    local: input.local,
    is_sicro: input.is_sicro,
    note: input.note ?? '',
  };
  if (input.is_sicro) {
    body.team_production = input.team_production ?? '0';
    body.fic = input.fic ?? '0';
    body.adc_labor = input.adc_labor ?? '0';
  } else {
    body.rounding_type = input.rounding_type;
  }
  return await expectOk<CompositionRecord>(
    ctx,
    'POST',
    '/base/mybase/compositions',
    body,
    'createComposition',
  );
}

export async function deleteComposition(
  ctx: OpContext,
  id: string,
): Promise<void> {
  await expectOk(
    ctx,
    'DELETE',
    `/base/mybase/compositions/${id}`,
    null,
    'deleteComposition',
  );
}

// ----- Items dentro de uma composição -----

export async function addItemsToComposition(
  ctx: OpContext,
  compositionId: string,
  items: CompositionItem[],
): Promise<CompositionRecord> {
  return await expectOk<CompositionRecord>(
    ctx,
    'POST',
    `/base/mybase/compositions/${compositionId}/add-items`,
    { items },
    'addItemsToComposition',
  );
}

export async function removeItemsFromComposition(
  ctx: OpContext,
  compositionId: string,
  toRemove: {
    compositions?: Array<{ code: string }>;
    resources?: Array<{ code: string }>;
  },
): Promise<CompositionRecord> {
  return await expectOk<CompositionRecord>(
    ctx,
    'DELETE',
    `/base/mybase/compositions/${compositionId}/remove-items`,
    toRemove,
    'removeItemsFromComposition',
  );
}

export async function addBasesToComposition(
  ctx: OpContext,
  compositionId: string,
  bases: Array<{
    name: string;
    local: string;
    version: string;
    status: boolean;
    region?: string;
    with_labor_charges?: boolean;
  }>,
): Promise<CompositionRecord> {
  return await expectOk<CompositionRecord>(
    ctx,
    'POST',
    `/base/mybase/compositions/${compositionId}/add_bases`,
    { bases },
    'addBasesToComposition',
  );
}

// =============================================================================
// Helpers de mais alto nível
// =============================================================================

/** Normaliza UF: pega o estado da licitação ou cai pro default. */
export function pickUF(licitacaoUF?: string | null, fallback = 'SP'): string {
  return (licitacaoUF && licitacaoUF.length === 2) ? licitacaoUF.toUpperCase() : fallback;
}

/** Mapeia fonte do edital pro `bank` esperado pela API. */
export function fonteToBank(fonte: string | null | undefined): string {
  if (!fonte) return 'OUTROS';
  const f = fonte.toUpperCase();
  // Conforme docs: SINAPI, SBC, SICRO, ORSE são bancos válidos
  if (['SINAPI', 'SBC', 'SICRO', 'ORSE', 'SEINFRA', 'FDE'].includes(f)) return f;
  // PROPRIA → bank "MYBASE" (insumos cadastrados na própria base do user)
  if (f === 'PROPRIA') return 'MYBASE';
  return 'OUTROS';
}
