// =============================================================================
// Edge Function: pdf-classificar-paginas
// =============================================================================
// Usa Gemini Flash (modelo barato e rápido) pra classificar cada página
// dos PDFs de uma licitação por categoria de relevância pra extração de
// orçamento.
//
// Não modifica nada — só retorna a análise. O passo seguinte
// (pdf-cortar-paginas) usa essa classificação pra montar PDFs filtrados.
//
// Body:
//   { licitacao_id: "uuid" }
//
// Response (200):
//   {
//     ok,
//     arquivos: [{
//       arquivo_id,
//       filename,
//       total_paginas,
//       paginas: [{ num, classe, confianca, justificativa }],
//       paginas_relevantes: [3, 4, ...],
//       paginas_descartaveis: [1, 2, 100, ...],
//       reducao_estimada_pct
//     }],
//     total_reducao_estimada_pct
//   }
// =============================================================================

import { handleCorsPreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/json.ts';
import { getServiceRoleClient, requireAuthenticatedUser } from '../_shared/supabase.ts';
import { callGemini, uploadGeminiFile, type GeminiPart } from '../_shared/gemini.ts';

const GEMINI_FLASH_MODEL = 'gemini-2.5-flash';

interface RequestBody {
  licitacao_id?: string;
}

const CLASSES_RELEVANTES = new Set([
  'PLANILHA_ORCAMENTARIA',
  'COMPOSICOES_PROPRIAS',
  'MEMORIAL_DESCRITIVO',
  'BDI_ENCARGOS',
  'LEIS_SOCIAIS',
  'CABECALHO_EDITAL',
]);

const CLASSES_DESCARTAVEIS = new Set([
  'CAPA',
  'INDICE',
  'DECLARACAO',
  'CERTIDAO',
  'TERMO_REFERENCIA_GENERICO',
  'ANEXO_NAO_ORCAMENTARIO',
  'ATA',
  'EDITAL_TEXTO_PURO',
  'BRANCO',
]);

interface PagClassificada {
  num: number;
  classe: string;
  confianca: number; // 0-1
  justificativa: string;
}

const PROMPT_CLASSIFICAR = `Você é um classificador de páginas de PDFs de editais de licitação pública brasileira.

Sua tarefa: pra CADA PÁGINA do PDF anexado, atribua uma classe e nível de confiança.

CLASSES POSSÍVEIS (use exatamente esses nomes em MAIÚSCULAS):

RELEVANTES (manter pra extração):
- PLANILHA_ORCAMENTARIA: tabela com itens, código, fonte, descrição, unidade, quantidade, preço unitário, preço total. Tipicamente o coração do orçamento.
- COMPOSICOES_PROPRIAS: detalhamento de composições adaptadas/próprias, com sub-itens (insumos, mão de obra, equipamentos) e coeficientes.
- MEMORIAL_DESCRITIVO: descrição técnica dos serviços a executar. Útil pra contexto de composições.
- BDI_ENCARGOS: tabela ou texto com Bonificação e Despesas Indiretas, percentual de BDI.
- LEIS_SOCIAIS: encargos sociais, percentual desonerado/não-desonerado, leis sociais sobre mão de obra.
- CABECALHO_EDITAL: informações administrativas da licitação (órgão, número edital, objeto, município, UF, data-base SINAPI/ORSE).

DESCARTÁVEIS (podem ser puladas sem perda):
- CAPA: capa do edital, contracapa, página inicial decorativa.
- INDICE: sumário, lista de páginas/anexos.
- DECLARACAO: declarações gerais (ME/EPP, idoneidade, ciência) que não impactam o cálculo.
- CERTIDAO: certidões fiscais, regularidade.
- TERMO_REFERENCIA_GENERICO: termo de referência sem dados orçamentários.
- ANEXO_NAO_ORCAMENTARIO: anexos administrativos, modelos de proposta vazia, formulários.
- ATA: atas de reunião, registros administrativos.
- EDITAL_TEXTO_PURO: corpo do edital legal (cláusulas, prazos) sem tabela de itens.
- BRANCO: página em branco ou com pouquíssimo conteúdo.

OUTRO: use só se não couber em nenhuma das acima. Por padrão, prefira RELEVANTES no caso de dúvida.

REGRAS:
1. Se a página tem QUALQUER tabela com colunas de quantidade/preço, classifique como PLANILHA_ORCAMENTARIA (mesmo se tem outras coisas).
2. Se tem texto técnico descrevendo serviços, é MEMORIAL_DESCRITIVO.
3. Confiança em escala 0.0 a 1.0. Se < 0.7, prefira a classe relevante (conservador — melhor manter do que perder).
4. Justificativa curta (1 frase, máx 100 chars).

FORMATO DA RESPOSTA — APENAS JSON, sem markdown:
{
  "total_paginas": <int>,
  "paginas": [
    {"num": 1, "classe": "CAPA", "confianca": 0.95, "justificativa": "Capa do edital com logotipo do órgão"},
    {"num": 2, "classe": "INDICE", "confianca": 0.9, "justificativa": "Sumário com lista de anexos"},
    {"num": 3, "classe": "PLANILHA_ORCAMENTARIA", "confianca": 0.85, "justificativa": "Tabela com itens, SINAPI/ORSE, qty, preço"}
  ]
}

Devolva o JSON COMPLETO, todas as páginas, sem omitir.`;

Deno.serve(async (req: Request) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse(405, 'Use POST.');

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, 'JSON inválido.');
  }

  const licitacaoId = body.licitacao_id?.trim();
  if (!licitacaoId) return errorResponse(400, 'licitacao_id é obrigatório.');

  const admin = getServiceRoleClient();
  const traceId = crypto.randomUUID();

  try {
    const user = await requireAuthenticatedUser(req);

    // 1) Pega credencial Gemini
    const { data: gCreds } = await admin
      .from('api_credentials')
      .select('id, vault_secret_id, escopo, owner_id')
      .eq('provider', 'gemini')
      .eq('ativo', true)
      .order('escopo', { ascending: true });
    const gCred = gCreds?.find((c) =>
      c.escopo === 'organizacional' || c.owner_id === user.id
    );
    if (!gCred) {
      return errorResponse(422, 'Credencial Gemini não encontrada.');
    }
    const { data: apiKey } = await admin.rpc('read_vault_secret', {
      p_secret_id: gCred.vault_secret_id,
    });
    if (typeof apiKey !== 'string' || !apiKey) {
      return errorResponse(500, 'Falha ao ler vault Gemini.');
    }

    // 2) Lista arquivos
    const { data: arquivos } = await admin
      .from('licitacao_arquivos')
      .select('id, storage_bucket, storage_path, filename_original, mime_type, size_bytes')
      .eq('licitacao_id', licitacaoId);
    if (!arquivos || arquivos.length === 0) {
      return errorResponse(404, 'Nenhum arquivo encontrado.');
    }

    // 3) Pra cada arquivo PDF, baixa, conta páginas e classifica via Gemini Flash
    const resultados = [];

    for (const a of arquivos) {
      if (a.mime_type !== 'application/pdf') continue;

      const { data: blob, error: dlErr } = await admin
        .storage
        .from(a.storage_bucket)
        .download(a.storage_path);
      if (dlErr || !blob) {
        resultados.push({
          arquivo_id: a.id,
          filename: a.filename_original,
          erro: `Falha ao baixar: ${dlErr?.message ?? 'sem blob'}`,
        });
        continue;
      }
      const buffer = new Uint8Array(await blob.arrayBuffer());

      // Upload pra Gemini Files API (raw, sem base64). Mantém o consumo de
      // memória estável mesmo pra PDFs grandes — sem isso, base64 +
      // JSON.stringify do payload estoura o WORKER_RESOURCE_LIMIT (546).
      // Total de páginas vem da resposta do próprio Gemini (parsed.total_paginas),
      // então não precisamos mais carregar pdf-lib aqui.
      let parts: GeminiPart[];
      try {
        const uploaded = await uploadGeminiFile({
          apiKey,
          bytes: buffer,
          mimeType: 'application/pdf',
          displayName: a.filename_original ?? 'edital.pdf',
        });
        parts = [
          { text: PROMPT_CLASSIFICAR },
          { fileData: { mimeType: 'application/pdf', fileUri: uploaded.uri } },
        ];
      } catch (e) {
        resultados.push({
          arquivo_id: a.id,
          filename: a.filename_original,
          total_paginas: 0,
          paginas: [],
          paginas_relevantes: [],
          paginas_descartaveis: [],
          reducao_estimada_pct: 0,
          erro_classificacao: e instanceof Error ? e.message.slice(0, 200) : String(e),
        });
        continue;
      }

      let classificacao: PagClassificada[] = [];
      let totalPaginas = 0;
      let erroClassif: string | undefined;
      try {
        const result = await callGemini({
          model: GEMINI_FLASH_MODEL,
          apiKey,
          parts,
          responseJson: true,
          temperature: 0.0,
          admin,
          callerUserId: user.id,
          licitacaoId,
          traceId,
        });
        const txt = result.text ?? '';
        const cleaned = txt.replace(/```(?:json)?\s*|\s*```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed?.paginas)) {
          classificacao = parsed.paginas as PagClassificada[];
          // total_paginas vem do próprio Gemini (substitui pdf-lib).
          // Fallback: maior `num` no array, ou tamanho do array.
          if (typeof parsed.total_paginas === 'number' && parsed.total_paginas > 0) {
            totalPaginas = parsed.total_paginas;
          } else {
            totalPaginas = classificacao.reduce(
              (mx, p) => Math.max(mx, p.num ?? 0),
              classificacao.length,
            );
          }
        } else {
          erroClassif = 'JSON do Gemini Flash não tem array `paginas`.';
        }
      } catch (e) {
        erroClassif = e instanceof Error ? e.message.slice(0, 200) : String(e);
      }

      // Decide quais páginas manter
      const paginasRelevantes: number[] = [];
      const paginasDescartaveis: number[] = [];
      for (const p of classificacao) {
        if (CLASSES_RELEVANTES.has(p.classe)) {
          paginasRelevantes.push(p.num);
        } else if (CLASSES_DESCARTAVEIS.has(p.classe) && p.confianca >= 0.7) {
          paginasDescartaveis.push(p.num);
        } else {
          // baixa confiança OU classe não reconhecida → mantém por segurança
          paginasRelevantes.push(p.num);
        }
      }
      // Se classificação falhou, mantém tudo
      if (classificacao.length === 0) {
        for (let i = 1; i <= totalPaginas; i++) paginasRelevantes.push(i);
      }

      const reducaoEstimadaPct = totalPaginas > 0
        ? Math.round((paginasDescartaveis.length / totalPaginas) * 100)
        : 0;

      resultados.push({
        arquivo_id: a.id,
        filename: a.filename_original,
        total_paginas: totalPaginas,
        paginas: classificacao,
        paginas_relevantes: paginasRelevantes.sort((x, y) => x - y),
        paginas_descartaveis: paginasDescartaveis.sort((x, y) => x - y),
        reducao_estimada_pct: reducaoEstimadaPct,
        erro_classificacao: erroClassif,
      });
    }

    const totPagAntes = resultados.reduce((s, r) => s + (r.total_paginas ?? 0), 0);
    const totPagDescartar = resultados.reduce((s, r) => s + (r.paginas_descartaveis?.length ?? 0), 0);
    const totalReducaoEstimadaPct = totPagAntes > 0
      ? Math.round((totPagDescartar / totPagAntes) * 100)
      : 0;

    return jsonResponse({
      ok: true,
      arquivos: resultados,
      total_paginas: totPagAntes,
      total_paginas_descartaveis: totPagDescartar,
      total_reducao_estimada_pct: totalReducaoEstimadaPct,
      trace_id: traceId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(500, `Classificação falhou: ${msg}`);
  }
});
