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
// Edge Function usa Gemini 2.5 Pro como padrão (key cadastrada + cota free razoável).
// Pra trocar pra Claude (Opus), basta cadastrar credencial Anthropic e mudar
// LLM_PROVIDER abaixo pra 'anthropic' + importar de '../_shared/anthropic.ts'.
import { callGemini, GeminiError } from '../_shared/gemini.ts';
import { PROMPT_VERSION, SYSTEM_PROMPT } from './prompt.ts';

const GEMINI_MODEL = 'gemini-2.5-pro';
const LLM_PROVIDER = 'gemini';
const VALID_START_STATUSES = new Set(['rascunho', 'aguardando_extracao']);

interface RequestBody {
  // Modo legado (1 arquivo). Continua suportado.
  arquivo_id?: string;
  // Modo novo (todos os arquivos da licitação). Preferido.
  licitacao_id?: string;
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

  const traceId = body.trace_id ?? crypto.randomUUID();
  const admin = getServiceRoleClient();
  let licitacaoId: string | null = body.licitacao_id?.trim() ?? null;
  let extracaoId: string | null = null;

  try {
    const user = await requireAuthenticatedUser(req);

    // ---- 1) Carrega arquivos da licitação ----------------------------------
    // Aceita 2 modos:
    //   - body.licitacao_id → pega TODOS os PDFs da licitação
    //   - body.arquivo_id   → modo legado, 1 arquivo só
    if (!licitacaoId && body.arquivo_id) {
      const { data: arquivoLeg, error: arqLegErr } = await admin
        .from('licitacao_arquivos')
        .select('licitacao_id')
        .eq('id', body.arquivo_id.trim())
        .maybeSingle();
      if (arqLegErr || !arquivoLeg) {
        return errorResponse(404, 'arquivo_id não encontrado.', arqLegErr?.message);
      }
      licitacaoId = arquivoLeg.licitacao_id;
    }
    if (!licitacaoId) {
      return errorResponse(400, 'licitacao_id (ou arquivo_id) é obrigatório.');
    }

    const { data: arquivos, error: arquivosErr } = await admin
      .from('licitacao_arquivos')
      .select(
        'id, licitacao_id, storage_bucket, storage_path, mime_type, filename_original, size_bytes, tipo',
      )
      .eq('licitacao_id', licitacaoId)
      .order('created_at', { ascending: true });
    if (arquivosErr) {
      return errorResponse(500, 'Falha ao ler licitacao_arquivos.', arquivosErr.message);
    }
    if (!arquivos || arquivos.length === 0) {
      return errorResponse(404, 'Nenhum arquivo encontrado pra esta licitação.');
    }
    const naoPdf = arquivos.find((a) => a.mime_type !== 'application/pdf');
    if (naoPdf) {
      return errorResponse(
        415,
        `Arquivo "${naoPdf.filename_original}" tem MIME ${naoPdf.mime_type}, só PDF é aceito.`,
      );
    }

    const { data: licitacao, error: licitErr } = await admin
      .from('licitacoes')
      .select('id, status')
      .eq('id', licitacaoId)
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

    // ---- 3) Transição: rascunho → aguardando_extracao (se preciso) → extraindo
    // A máquina de estados (validate_licitacao_status_transition) exige passar
    // por aguardando_extracao antes de extraindo.
    if (licitacao.status === 'rascunho') {
      const { error: stPre } = await admin
        .from('licitacoes')
        .update({ status: 'aguardando_extracao' })
        .eq('id', licitacaoId);
      if (stPre) {
        return errorResponse(500, 'Falha ao transicionar rascunho → aguardando_extracao.', stPre.message);
      }
    }
    const { error: stT1 } = await admin
      .from('licitacoes')
      .update({ status: 'extraindo' })
      .eq('id', licitacaoId);
    if (stT1) {
      return errorResponse(500, 'Falha ao transicionar para extraindo.', stT1.message);
    }

    // arquivo_id principal: o primeiro de tipo planilha_orcamentaria,
    // ou o primeiro arquivo em geral
    const arquivoPrincipal =
      arquivos.find((a) => a.tipo === 'planilha_orcamentaria') ?? arquivos[0];

    const { data: extr, error: extrErr } = await admin
      .from('extracoes_ocr')
      .insert({
        licitacao_id: licitacaoId,
        arquivo_id: arquivoPrincipal.id,
        llm_provider: LLM_PROVIDER,
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

    // ---- 4) Baixa TODOS PDFs + chama Gemini --------------------------------
    const startedAt = Date.now();

    const tipoLabel: Record<string, string> = {
      planilha_orcamentaria: 'Planilha orçamentária (principal)',
      memorial_descritivo: 'Memorial descritivo / composições',
      projeto_tecnico: 'Projeto técnico',
      edital: 'Edital (texto)',
      anexo: 'Anexo (BDI, leis sociais ou outro)',
    };

    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
      { text: SYSTEM_PROMPT },
    ];

    if (arquivos.length > 1) {
      parts.push({
        text: `\nESTE EDITAL FOI ENVIADO EM ${arquivos.length} ARQUIVOS. A ordem dos PDFs anexados abaixo é:\n` +
          arquivos.map((a, i) =>
            `  [${i + 1}] ${tipoLabel[a.tipo] ?? a.tipo} — ${a.filename_original}`
          ).join('\n') +
          '\nLeia todos antes de produzir o JSON. Use a planilha orçamentária como fonte primária dos itens, e o memorial/anexos pra preencher cabecalho (BDI, leis sociais, desoneração) e detalhes de composições próprias.\n',
      });
    }
    for (const a of arquivos) {
      const { data: blob, error: dlErr } = await admin
        .storage
        .from(a.storage_bucket)
        .download(a.storage_path);
      if (dlErr || !blob) {
        throw new Error(`Falha ao baixar "${a.filename_original}" do Storage: ${dlErr?.message ?? 'sem dado'}`);
      }
      const buffer = new Uint8Array(await blob.arrayBuffer());
      parts.push({
        inlineData: { mimeType: 'application/pdf', data: uint8ToBase64(buffer) },
      });
    }

    const result = await callGemini({
      model: GEMINI_MODEL,
      apiKey,
      parts,
      responseJson: true,
      temperature: 0.1,
      admin,
      callerUserId: user.id,
      licitacaoId,
      traceId,
    });
    const duracaoMs = Date.now() - startedAt;

    // ---- 5) Parse + validação --------------------------------------------------
    function stripCodeFences(s: string): string {
      const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (m) return m[1].trim();
      return s.trim();
    }

    // Recuperação resiliente do JSON do Gemini:
    // 1) JSON.parse direto
    // 2) jsonrepair (corrige aspas faltando, vírgulas finais, etc — comum em LLM)
    // 3) Truncar ao último item válido em `itens: [...]` (fallback de emergência
    //    — preserva o que deu pra extrair mesmo com syntax error no meio)
    //
    // Observação: o passo (3) é destrutivo (perde os items após o erro), mas
    // 99% melhor que descartar tudo e exigir re-extração manual. Item que
    // ficou trunco vira warning na metadata.extracao_warnings.
    async function tentarParse(textOriginal: string): Promise<{
      obj: unknown;
      warnings: string[];
    }> {
      const cleaned = stripCodeFences(textOriginal);
      const warnings: string[] = [];

      // (1) Direto
      try {
        return { obj: JSON.parse(cleaned), warnings };
      } catch (e1) {
        warnings.push(
          `JSON do Gemini não parseou direto (${e1 instanceof Error ? e1.message.slice(0, 120) : 'erro'}). Tentando jsonrepair…`,
        );
      }

      // (2) jsonrepair
      try {
        const { jsonrepair } = await import('https://esm.sh/jsonrepair@3.12.0');
        const repaired = jsonrepair(cleaned);
        const obj = JSON.parse(repaired);
        warnings.push('JSON recuperado via jsonrepair (havia vírgulas/aspas inconsistentes).');
        return { obj, warnings };
      } catch (e2) {
        warnings.push(
          `jsonrepair também falhou (${e2 instanceof Error ? e2.message.slice(0, 120) : 'erro'}). Tentando truncar ao último item válido…`,
        );
      }

      // (3) Truncar manualmente ao último item válido
      // Estratégia: localizar `"itens": [` e iterar fechando `]}` em cada
      // posição de `}, {` até achar prefixo que valida.
      const itensIdx = cleaned.indexOf('"itens"');
      if (itensIdx === -1) {
        throw new Error('JSON do Gemini sem "itens" — não dá pra recuperar nada.');
      }
      const arrStart = cleaned.indexOf('[', itensIdx);
      if (arrStart === -1) {
        throw new Error('JSON do Gemini sem array de itens — não dá pra recuperar.');
      }
      // Procura todos os candidatos `}, {` no array — cada um marca o fim de
      // um item. Tenta do mais recente pro mais antigo até parsear OK.
      const boundaries: number[] = [];
      let pos = arrStart;
      while (true) {
        const next = cleaned.indexOf('},', pos + 1);
        if (next === -1) break;
        boundaries.push(next + 1); // posição depois do `}` (antes da vírgula)
        pos = next;
      }
      // Tenta truncar e fechar como `]}`. Do último candidato pro primeiro.
      for (let i = boundaries.length - 1; i >= 0; i--) {
        const truncado = cleaned.slice(0, boundaries[i]) + ']}';
        try {
          const obj = JSON.parse(truncado);
          warnings.push(
            `JSON truncado ao último item válido (${boundaries.length - i} item(ns) perdidos a partir da posição ~${boundaries[i]}). Re-extraia o JSON se precisar do detalhamento completo dos últimos items.`,
          );
          return { obj, warnings };
        } catch {
          // tenta o anterior
        }
      }

      throw new Error(
        `JSON do Gemini totalmente irrecuperável após 3 tentativas. ` +
        `Início: ${cleaned.slice(0, 200)}`,
      );
    }

    let parsed: ExtractedJson;
    const extracaoWarnings: string[] = [];
    try {
      const { obj, warnings } = await tentarParse(result.text!);
      extracaoWarnings.push(...warnings);
      parsed = validateExtractedJson(obj);
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      throw new Error(`JSON do Gemini inválido: ${msg}. Início: ${result.text?.slice(0, 200)}`);
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

    // Persiste warnings de recuperação no erro_detalhe (pra reanálise/auditoria)
    if (extracaoWarnings.length > 0 && extracaoId) {
      await admin.from('extracoes_ocr').update({
        erro_detalhe: `[recuperação] ${extracaoWarnings.join(' | ')}`,
      }).eq('id', extracaoId);
    }

    return jsonResponse({
      extracao_id: extracaoId,
      licitacao_id: licitacaoId,
      itens_extraidos: parsed.itens.length,
      sub_itens_proprios: subItens.length,
      tokens_input: result.usage.promptTokenCount ?? null,
      tokens_output: result.usage.candidatesTokenCount ?? null,
      custo_usd: result.estimatedCostUsd,
      duracao_ms: duracaoMs,
      warnings: extracaoWarnings,
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
