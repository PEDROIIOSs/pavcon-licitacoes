// =============================================================================
// Edge Function: pdf-cortar-paginas
// =============================================================================
// Recebe arquivo_id + lista de páginas a manter, gera um novo PDF só com
// essas páginas e substitui o original no Storage.
//
// Body:
//   {
//     licitacao_id: "uuid",
//     cortes: [{ arquivo_id, paginas_manter: [1,3,5,10-30] }]
//   }
//
// Response (200):
//   { ok, resultados: [{ arquivo_id, antes_bytes, depois_bytes, paginas_antes, paginas_depois }] }
// =============================================================================

import { PDFDocument } from 'https://esm.sh/pdf-lib@1.17.1';
import { handleCorsPreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/json.ts';
import { getServiceRoleClient, requireAuthenticatedUser } from '../_shared/supabase.ts';

interface RequestBody {
  licitacao_id?: string;
  cortes?: Array<{ arquivo_id: string; paginas_manter: number[] }>;
}

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
  const cortes = body.cortes;
  if (!licitacaoId) return errorResponse(400, 'licitacao_id é obrigatório.');
  if (!Array.isArray(cortes) || cortes.length === 0) {
    return errorResponse(400, 'cortes (array de {arquivo_id, paginas_manter}) é obrigatório.');
  }

  const admin = getServiceRoleClient();

  try {
    await requireAuthenticatedUser(req);

    const resultados = [];

    for (const corte of cortes) {
      const { arquivo_id, paginas_manter } = corte;
      if (!arquivo_id || !Array.isArray(paginas_manter) || paginas_manter.length === 0) {
        resultados.push({
          arquivo_id,
          erro: 'arquivo_id ou paginas_manter inválido.',
        });
        continue;
      }

      // 1) Carrega arquivo do DB
      const { data: arquivo, error: arqErr } = await admin
        .from('licitacao_arquivos')
        .select('id, storage_bucket, storage_path, filename_original, mime_type, size_bytes, licitacao_id')
        .eq('id', arquivo_id)
        .maybeSingle();
      if (arqErr || !arquivo) {
        resultados.push({ arquivo_id, erro: `Arquivo não encontrado: ${arqErr?.message ?? 'sem dado'}` });
        continue;
      }
      if (arquivo.licitacao_id !== licitacaoId) {
        resultados.push({ arquivo_id, erro: 'Arquivo não pertence à licitação informada.' });
        continue;
      }
      if (arquivo.mime_type !== 'application/pdf') {
        resultados.push({ arquivo_id, erro: 'Só PDFs.' });
        continue;
      }

      // 2) Baixa o PDF original
      const { data: blob, error: dlErr } = await admin
        .storage
        .from(arquivo.storage_bucket)
        .download(arquivo.storage_path);
      if (dlErr || !blob) {
        resultados.push({ arquivo_id, erro: `Download falhou: ${dlErr?.message ?? 'sem blob'}` });
        continue;
      }
      const original = new Uint8Array(await blob.arrayBuffer());

      // 3) Constrói novo PDF só com as páginas selecionadas
      try {
        const srcDoc = await PDFDocument.load(original, { ignoreEncryption: true });
        const totalAntes = srcDoc.getPageCount();
        const indicesValidos = paginas_manter
          .filter((p) => p >= 1 && p <= totalAntes)
          .map((p) => p - 1) // pdf-lib usa indices 0-based
          .sort((a, b) => a - b);

        if (indicesValidos.length === 0) {
          resultados.push({ arquivo_id, erro: 'Nenhuma página válida na lista.' });
          continue;
        }

        const newDoc = await PDFDocument.create();
        newDoc.setTitle('');
        newDoc.setAuthor('');
        newDoc.setProducer('OrçaPav AI');
        newDoc.setCreator('OrçaPav AI');

        const copiedPages = await newDoc.copyPages(srcDoc, indicesValidos);
        copiedPages.forEach((p) => newDoc.addPage(p));

        const novo = await newDoc.save({
          useObjectStreams: true,
          addDefaultPage: false,
          objectsPerTick: 50,
        });

        // 4) Sobrescreve no Storage
        const { error: upErr } = await admin
          .storage
          .from(arquivo.storage_bucket)
          .update(arquivo.storage_path, novo, {
            contentType: 'application/pdf',
            upsert: true,
          });
        if (upErr) {
          resultados.push({ arquivo_id, erro: `Upload falhou: ${upErr.message}` });
          continue;
        }

        // 5) Atualiza size_bytes + total_paginas no DB
        await admin
          .from('licitacao_arquivos')
          .update({
            size_bytes: novo.length,
            total_paginas: indicesValidos.length,
          })
          .eq('id', arquivo_id);

        resultados.push({
          arquivo_id,
          filename: arquivo.filename_original,
          antes_bytes: original.length,
          depois_bytes: novo.length,
          paginas_antes: totalAntes,
          paginas_depois: indicesValidos.length,
          reducao_pct: Number((((original.length - novo.length) / original.length) * 100).toFixed(1)),
        });
      } catch (e) {
        resultados.push({
          arquivo_id,
          erro: `Erro ao processar PDF: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`,
        });
      }
    }

    const totAntes = resultados.reduce((s, r) => s + ((r as { antes_bytes?: number }).antes_bytes ?? 0), 0);
    const totDepois = resultados.reduce((s, r) => s + ((r as { depois_bytes?: number }).depois_bytes ?? 0), 0);
    const totalReducaoPct = totAntes > 0
      ? Number((((totAntes - totDepois) / totAntes) * 100).toFixed(1))
      : 0;

    return jsonResponse({
      ok: true,
      resultados,
      total_antes_bytes: totAntes,
      total_depois_bytes: totDepois,
      total_reducao_pct: totalReducaoPct,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(500, `Corte falhou: ${msg}`);
  }
});
