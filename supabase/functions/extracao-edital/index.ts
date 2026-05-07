// =============================================================================
// Edge Function: extracao-edital
// =============================================================================
// Pipeline:
//   1. Lê arquivo de licitacao_arquivos (precisa estar em Storage 'editais')
//   2. Valida licitacao.status (rascunho ou aguardando_extracao)
//   3. Resolve credencial Gemini ativa (provider='gemini') e o API key do Vault
//   4. Transição: licitacao.status = 'extraindo'
//   5. Cria extracoes_ocr (status='processando')
//   6. Baixa PDF do Storage, base64, manda pro Gemini 2.5 Pro
//   7. Parseia JSON, valida shape mínimo
//   8. Persiste:
//        extracoes_ocr (status='sucesso', json_extraido, custo, tokens)
//        composicoes_extraidas (uma linha por item)
//        composicao_propria_itens (quando fonte=PROPRIA)
//   9. Transição: 'extracao_concluida' → 'aguardando_revisao_humana'
//
// Erros de qualquer etapa após (4) viram extracoes_ocr.status='falha' +
// licitacao.status='erro'.
// =============================================================================

import { handleCorsPreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/json.ts';
import {
  getServiceRoleClient,
  HttpError,
  requireAuthenticatedUser,
} from '../_shared/supabase.ts';
import { callGemini, GeminiError } from '../_shared/gemini.ts';
import { PROMPT_VERSION, SYSTEM_PROMPT } from './prompt.ts';

const GEMINI_MODEL = 'gemini-2.5-pro';
const VALID_START_STATUSES = new Set(['rascunho', 'aguardando_extracao']);

interface RequestBody {
  arquivo_id?: string;
  trace_id?: string;
}

interface ExtractedItem {
  item_codigo: string;
  nivel: number;
  pai: string | null;
  tipo: 'grupo' | 'servico';
  codigo: string | null;
  fonte: string | null;
  descricao: string;
  unidade: string | null;
  quantidade: number | null;
  preco_unitario_sem_bdi: number | null;
  preco_unitario_com_bdi: number | null;
  preco_total: number | null;
  composicao_propria?: {
    itens: Array<{
      classe: string;
      codigo: string | null;
      fonte: string;
      descricao: string;
      unidade: string | null;
      coeficiente: number;
      preco_unitario: number | null;
    }>;
  };
}

interface ExtractedJson {
  cabecalho: Record<string, unknown>;
  itens: ExtractedItem[];
}

function validateExtractedJson(obj: unknown): ExtractedJson {
  if (!obj || typeof obj !== 'object') {
    throw new Error('JSON do Gemini não é objeto.');
  }
  const o = obj as Record<string, unknown>;
  if (!o.cabecalho || typeof o.cabecalho !== 'object') {
    throw new Error('Faltou "cabecalho" no JSON.');
  }
  if (!Array.isArray(o.itens)) {
    throw new Error('Faltou "itens" (array) no JSON.');
  }
  return { cabecalho: o.cabecalho as Record<string, unknown>, itens: o.itens as ExtractedItem[] };
}

function uint8ToBase64(bytes: Uint8Array): string {
  // Converte sem estourar pilha (PDFs grandes).
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

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

  const arquivoId = body.arquivo_id?.trim();
  if (!arquivoId) {
    return errorResponse(400, 'arquivo_id é obrigatório.');
  }

  const traceId = body.trace_id ?? crypto.randomUUID();
  const admin = getServiceRoleClient();
  let licitacaoId: string | null = null;
  let extracaoId: string | null = null;

  try {
    const user = await requireAuthenticatedUser(req);

    // ---- 1) Carrega arquivo + licitação ------------------------------------
    const { data: arquivo, error: arquivoErr } = await admin
      .from('licitacao_arquivos')
      .select(
        'id, licitacao_id, storage_bucket, storage_path, mime_type, filename_original, size_bytes',
      )
      .eq('id', arquivoId)
      .maybeSingle();
    if (arquivoErr) {
      return errorResponse(500, 'Falha ao ler licitacao_arquivos.', arquivoErr.message);
    }
    if (!arquivo) {
      return errorResponse(404, 'Arquivo não encontrado.');
    }
    if (arquivo.mime_type !== 'application/pdf') {
      return errorResponse(415, `MIME ${arquivo.mime_type} não suportado (apenas PDF).`);
    }
    licitacaoId = arquivo.licitacao_id;

    const { data: licitacao, error: licitErr } = await admin
      .from('licitacoes')
      .select('id, status')
      .eq('id', arquivo.licitacao_id)
      .maybeSingle();
    if (licitErr || !licitacao) {
      return errorResponse(500, 'Falha ao carregar licitação.', licitErr?.message);
    }
    if (!VALID_START_STATUSES.has(licitacao.status)) {
      return errorResponse(
        409,
        `Licitação está em "${licitacao.status}", esperado um de: ${[...VALID_START_STATUSES].join(', ')}.`,
      );
    }

    // ---- 2) Resolve credencial Gemini --------------------------------------
    const { data: gCreds, error: gCredsErr } = await admin
      .from('api_credentials')
      .select('id, vault_secret_id, ativo, escopo, owner_id')
      .eq('provider', 'gemini')
      .eq('ativo', true)
      .order('escopo', { ascending: true });
    if (gCredsErr) {
      return errorResponse(500, 'Falha ao listar credenciais Gemini.', gCredsErr.message);
    }
    const gCred = gCreds?.find((c) =>
      c.escopo === 'organizacional' || c.owner_id === user.id
    );
    if (!gCred) {
      return errorResponse(
        422,
        'Nenhuma credencial Gemini ativa cadastrada (provider="gemini").',
      );
    }
    const { data: apiKey, error: vaultErr } = await admin.rpc(
      'read_vault_secret',
      { p_secret_id: gCred.vault_secret_id },
    );
    if (vaultErr || typeof apiKey !== 'string' || !apiKey) {
      return errorResponse(500, 'Vault não retornou a API key do Gemini.', vaultErr?.message);
    }

    // ---- 3) Transição: extraindo + cria extracoes_ocr ----------------------
    const { error: stT1 } = await admin
      .from('licitacoes')
      .update({ status: 'extraindo' })
      .eq('id', licitacaoId);
    if (stT1) {
      return errorResponse(500, 'Falha ao transicionar para extraindo.', stT1.message);
    }

    const { data: extr, error: extrErr } = await admin
      .from('extracoes_ocr')
      .insert({
        licitacao_id: licitacaoId,
        arquivo_id: arquivoId,
        llm_provider: 'gemini',
        llm_model: GEMINI_MODEL,
        prompt_versao: PROMPT_VERSION,
        status: 'processando',
      })
      .select('id')
      .single();
    if (extrErr || !extr) {
      return errorResponse(500, 'Falha ao criar extracoes_ocr.', extrErr?.message);
    }
    extracaoId = extr.id;

    // ---- 4) Baixa PDF + chama Gemini ---------------------------------------
    const startedAt = Date.now();
    const { data: blob, error: dlErr } = await admin
      .storage
      .from(arquivo.storage_bucket)
      .download(arquivo.storage_path);
    if (dlErr || !blob) {
      throw new Error(`Falha ao baixar PDF do Storage: ${dlErr?.message ?? 'sem dado'}`);
    }
    const buffer = new Uint8Array(await blob.arrayBuffer());
    const base64 = uint8ToBase64(buffer);

    const result = await callGemini({
      model: GEMINI_MODEL,
      apiKey,
      parts: [
        { text: SYSTEM_PROMPT },
        { inlineData: { mimeType: 'application/pdf', data: base64 } },
      ],
      responseJson: true,
      temperature: 0.1,
      admin,
      callerUserId: user.id,
      licitacaoId,
      traceId,
    });
    const duracaoMs = Date.now() - startedAt;

    // ---- 5) Parse + validação --------------------------------------------------
    let parsed: ExtractedJson;
    try {
      const obj = JSON.parse(result.text!);
      parsed = validateExtractedJson(obj);
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      throw new Error(`JSON do Gemini inválido: ${msg}`);
    }

    // ---- 6) Persistir composições -------------------------------------------
    const composicoesRows = parsed.itens.map((item, idx) => ({
      licitacao_id: licitacaoId!,
      extracao_id: extracaoId!,
      item_codigo: item.item_codigo,
      item_nivel: item.nivel,
      item_pai_codigo: item.pai,
      tipo_linha: item.tipo,
      codigo: item.codigo,
      fonte: item.fonte,
      descricao: item.descricao,
      unidade: item.unidade,
      quantidade: item.quantidade,
      preco_unitario_sem_bdi: item.preco_unitario_sem_bdi,
      preco_unitario_com_bdi: item.preco_unitario_com_bdi,
      preco_total: item.preco_total,
      ordem: idx,
      metadata: {},
    }));

    if (composicoesRows.length > 0) {
      const { error: cErr } = await admin
        .from('composicoes_extraidas')
        .insert(composicoesRows);
      if (cErr) {
        throw new Error(`Falha ao gravar composicoes_extraidas: ${cErr.message}`);
      }
    }

    // Pega de volta os ids pra montar composicao_propria_itens (mantém ordem)
    const { data: composicoesPersistidas, error: cpErr } = await admin
      .from('composicoes_extraidas')
      .select('id, item_codigo, fonte')
      .eq('licitacao_id', licitacaoId!)
      .eq('extracao_id', extracaoId!)
      .order('ordem');
    if (cpErr) {
      throw new Error(`Falha ao reler composicoes_extraidas: ${cpErr.message}`);
    }

    const idByCodigo = new Map(
      (composicoesPersistidas ?? []).map((c) => [c.item_codigo, c.id]),
    );

    const subItens: Array<Record<string, unknown>> = [];
    for (const item of parsed.itens) {
      if (item.fonte !== 'PROPRIA' || !item.composicao_propria?.itens) continue;
      const compId = idByCodigo.get(item.item_codigo);
      if (!compId) continue;
      item.composicao_propria.itens.forEach((sub, idx) => {
        subItens.push({
          composicao_extraida_id: compId,
          classe: sub.classe,
          codigo: sub.codigo,
          fonte: sub.fonte,
          descricao: sub.descricao,
          unidade: sub.unidade,
          coeficiente: sub.coeficiente,
          preco_unitario: sub.preco_unitario,
          preco_total: sub.preco_unitario != null
            ? sub.coeficiente * sub.preco_unitario
            : null,
          ordem: idx,
        });
      });
    }
    if (subItens.length > 0) {
      const { error: subErr } = await admin
        .from('composicao_propria_itens')
        .insert(subItens);
      if (subErr) {
        throw new Error(`Falha ao gravar composicao_propria_itens: ${subErr.message}`);
      }
    }

    // ---- 7) Concluir extração + transição licitação ------------------------
    const { error: doneErr } = await admin
      .from('extracoes_ocr')
      .update({
        status: 'sucesso',
        json_extraido: { cabecalho: parsed.cabecalho, itens: parsed.itens },
        tokens_input: result.usage.promptTokenCount ?? null,
        tokens_output: result.usage.candidatesTokenCount ?? null,
        custo_usd: result.estimatedCostUsd,
        duracao_ms: duracaoMs,
        concluido_em: new Date().toISOString(),
      })
      .eq('id', extracaoId);
    if (doneErr) {
      throw new Error(`Falha ao concluir extracoes_ocr: ${doneErr.message}`);
    }

    // Transições em sequência (validate_licitacao_status_transition checa)
    await admin.from('licitacoes').update({ status: 'extracao_concluida' }).eq('id', licitacaoId);
    await admin.from('licitacoes').update({ status: 'aguardando_revisao_humana' }).eq('id', licitacaoId);

    return jsonResponse({
      extracao_id: extracaoId,
      licitacao_id: licitacaoId,
      itens_extraidos: parsed.itens.length,
      sub_itens_proprios: subItens.length,
      tokens_input: result.usage.promptTokenCount ?? null,
      tokens_output: result.usage.candidatesTokenCount ?? null,
      custo_usd: result.estimatedCostUsd,
      duracao_ms: duracaoMs,
      trace_id: traceId,
    });
  } catch (err) {
    // Failover: marca extração como falha e licitação como erro
    const msg = err instanceof Error ? err.message : String(err);
    const details = err instanceof GeminiError ? err.details : null;
    if (extracaoId) {
      await admin.from('extracoes_ocr').update({
        status: 'falha',
        erro_detalhe: msg,
        concluido_em: new Date().toISOString(),
      }).eq('id', extracaoId);
    }
    if (licitacaoId) {
      await admin.from('licitacoes').update({ status: 'erro' }).eq('id', licitacaoId);
    }
    if (err instanceof HttpError) {
      return errorResponse(err.status, err.message, err.details);
    }
    if (err instanceof GeminiError) {
      return errorResponse(502, err.message, details);
    }
    console.error('[extracao-edital] erro:', err);
    return errorResponse(500, msg, details);
  }
});
