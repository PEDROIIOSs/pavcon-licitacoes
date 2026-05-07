# Edge Function: `extracao-edital`

OCR + extração estruturada do PDF da planilha orçamentária do edital, via **Gemini 2.5 Pro**. Transforma o PDF em JSON normalizado e persiste em `extracoes_ocr` + `composicoes_extraidas` + `composicao_propria_itens`.

## Pré-requisitos

1. **Credencial Gemini cadastrada**:
   ```sql
   SELECT vault.create_secret('SUA_GEMINI_API_KEY', 'gemini_pavcon_main');
   -- copie o UUID retornado
   INSERT INTO api_credentials (owner_id, escopo, provider, vault_secret_id, metadata)
   VALUES (
     (SELECT id FROM profiles WHERE role = 'admin' LIMIT 1),
     'organizacional',
     'gemini',
     '<UUID_RETORNADO>',
     '{"model_default": "gemini-2.5-pro"}'::jsonb
   );
   ```

2. **Bucket `editais` no Storage**:
   ```sql
   INSERT INTO storage.buckets (id, name, public) VALUES ('editais', 'editais', false);
   -- + policies: só admin/orcamentista podem upload, todos autenticados podem ler
   ```

3. **Arquivo já uploadado** com row em `licitacao_arquivos` apontando pra `storage.objects`.

4. **Licitação em status `rascunho` ou `aguardando_extracao`**.

## Entrada

```jsonc
POST /functions/v1/extracao-edital
Authorization: Bearer <JWT do usuário Pavcon>

{
  "arquivo_id": "uuid-do-licitacao_arquivos",
  "trace_id": "uuid"   // opcional
}
```

## Resposta (200)

```json
{
  "extracao_id": "uuid",
  "licitacao_id": "uuid",
  "itens_extraidos": 87,
  "sub_itens_proprios": 134,
  "tokens_input": 145000,
  "tokens_output": 22000,
  "custo_usd": 0.401,
  "duracao_ms": 78340,
  "trace_id": "..."
}
```

## Fluxo de status

```
licitacao.status:
  rascunho | aguardando_extracao
       │ (entrada da função)
       ▼
  extraindo
       │ (Gemini chamado, JSON parseado, dados gravados)
       ▼
  extracao_concluida
       │ (transição imediata)
       ▼
  aguardando_revisao_humana   ← orçamentista revisa e aprova

Em caso de erro a qualquer momento após "extraindo":
  licitacao.status = erro
  extracoes_ocr.status = falha + erro_detalhe preenchido
```

## Versionamento de prompt

O prompt fica em `prompt.ts` com a constante `PROMPT_VERSION` (atualmente `pavcon-extracao-edital-v1`). Cada extração grava em `extracoes_ocr.prompt_versao` qual versão foi usada — permite reprocessar com nova versão e comparar resultados.

**Regra:** NÃO edite o prompt v1. Crie `prompt-v2.ts` e atualize o import no `index.ts`.

## Custos esperados

Gemini 2.5 Pro (jan/2026):
- ≤200K input: **$1.25/M tokens**
- \>200K input: $2.50/M tokens
- ≤200K output: **$10/M tokens**
- \>200K output: $15/M tokens

Edital de ~120 páginas (CSPII): ~150K tokens de input, ~25K de output → **~$0.45/extração**.
A função grava `extracoes_ocr.custo_usd` automaticamente. Use a query abaixo pra acompanhar:

```sql
SELECT date_trunc('day', created_at) AS dia,
       count(*) AS extracoes,
       sum(custo_usd) AS gasto_usd
FROM extracoes_ocr
WHERE llm_provider = 'gemini'
GROUP BY 1 ORDER BY 1 DESC;
```

## Limites e atenções

- **Edge Function timeout** (Supabase Pro: 25min, Free: 5min). Editais com 200+ páginas podem aproximar do limite. Se virar gargalo, mover pra background job (`pg_net` + worker).
- **Re-extração**: ainda não é idempotente. Pra reprocessar o mesmo arquivo, você precisa apagar a extração antiga + composições primeiro, ou ajustar o status da licitação manualmente.
- **MIME type**: rejeita tudo que não for `application/pdf`.

## Deploy

```powershell
npx supabase functions deploy extracao-edital
```
