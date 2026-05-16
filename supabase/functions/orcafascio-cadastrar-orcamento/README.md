# Edge Function: `orcafascio-cadastrar-orcamento`

**Cria orçamento COMPLETO no Orçafascio via API interna `/v2023/`** — automação 100% (Plano B' full).

⚠️ **Endpoints não-oficiais**: usa a API interna do Orçafascio (`/v2023/...`) mapeada via reverse-engineering. Sujeita a mudar sem aviso. Em caso de breakage, volta pro Plano A híbrido (`orcafascio-cadastrar-edital`).

## Pré-requisitos

1. **Credencial web cadastrada** em `api_credentials`:
   - `provider='orcafascio'`
   - `metadata.auth_type='web'`
   - Vault armazena a **senha de login** (NÃO o secret_token)

2. **Licitação em status**:
   - `aguardando_revisao_humana` OU
   - `criando_composicoes_edital` OU
   - `criando_orcamento_base` OU
   - `fase1_concluida` (retry)

3. **Composições já cadastradas no MyBase** via `orcafascio-cadastrar-edital` (Plano A):
   - As composições PROPRIA precisam ter `orcafascio_composition_id` preenchido
   - Senão a função pula essas linhas (warnings nos logs)

## Entrada

```jsonc
POST /functions/v1/orcafascio-cadastrar-orcamento
Authorization: Bearer <JWT do usuário Pavcon>

{
  "licitacao_id": "uuid",
  "credential_id": "uuid-da-credencial-web",
  "trace_id": "uuid"
}
```

## Resposta (200)

```json
{
  "ok": true,
  "budget_id": "6a087cb183b29e26860fa488",
  "budget_url": "https://app.orcafascio.com/orc/orcamentos/6a087cb1...",
  "etapas_criadas": 7,
  "composicoes_criadas": 16,
  "total_itens_batch": 23,
  "bdi": 22.0,
  "leis_sociais_horista": 113.78,
  "bancos_configurados": ["SINAPI PI 03/2026", "SICRO PI 01/2026", "ORSE SE 02/2026"]
}
```

## Fluxo interno

```
1. Auth: orcafascio-web-auth helper → cookie _orcafascio_session
2. Buscar CSRF token em /orc/orcamentos/new
3. POST /orc/orcamentos                      → cria budget (codigo, descricao, categoria, ...)
4. POST /v2023/bud/budgets/{id}/update_bases → SINAPI, SICRO, ORSE com estado+data
5. POST /v2023/orc/orcamentos/update_bdi?id  → BDI do edital (ex: 22%)
6. POST /v2023/orc/orcamentos/update_leis_sociais?id → encargos sociais
7. POST /v2023/bud/budgets/{id}/items/       → BATCH com TODAS as etapas + composições
   (em chunks de 50 itens se houver muitas)
8. UPDATE licitacoes SET status='fase1_concluida'
```

## Limitações conhecidas (Plano A híbrido vs Plano B' total)

- Compositions próprias precisam estar cadastradas previamente no MyBase (via `orcafascio-cadastrar-edital`)
- Endpoints `/v2023/` podem mudar sem aviso (não-oficiais)
- Captura parcial dos 21 campos de `POST /orc/orcamentos` — usa defaults pra os 13 não capturados; pode falhar se algum for obrigatório

## Mapeamento

| Campo licitação / extração | Campo Orçafascio |
|---|---|
| `licitacao.titulo` | `orc_orcamento[descricao]` |
| `licitacao.municipio` | `orc_orcamento[codigo]` |
| `licitacao.uf` | UF default dos bancos (SINAPI_estado, etc.) |
| `cabecalho.bdi_percentual` | `bdi_manual` |
| `cabecalho.leis_sociais_percentual` | `charge_hourly` |
| `cabecalho.com_desoneracao` | `desonerado` |
| `cabecalho.bases_utilizadas` | banco fonte (SINAPI/ORSE/SICRO/...) |
| `cabecalho.data_base_descricao` | parsed pra `SINAPI_data` ("03/2026"), etc. |
| `composicoes_extraidas.item_codigo` (tipo_linha=grupo) | `new_items[i][kind]=phase`, `[itemization]`, `[descr]` |
| `composicoes_extraidas` (tipo_linha=servico) | `new_items[i][kind]=composition`, `[base]`, `[code]`, `[qty]` |
| PROPRIA com `orcafascio_composition_id` | base=MYBASE, code=<orcafascio_composition_id> |

## Deploy

```powershell
npx supabase functions deploy orcafascio-cadastrar-orcamento
```

## Como o bot fica 100% após essa função

```
Upload PDF → Extração Gemini → Revisão humana
  → Aprovar → orcafascio-cadastrar-edital (MyBase)
  → orcafascio-cadastrar-orcamento (orçamento completo) ✓ NOVO
  → fase1_concluida — orçamento pronto pra ser visualizado em
    https://app.orcafascio.com/orc/orcamentos/{budget_id}
```
