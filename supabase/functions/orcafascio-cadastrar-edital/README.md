# Edge Function: `orcafascio-cadastrar-edital`

Cadastra no MyBase do Orçafascio (via API pública) **as composições próprias** de uma licitação. Usa o caminho confirmado pela [documentação oficial](https://orcafascio.apidog.io/) — endpoints `/base/mybase/*`.

## ⚠️ Limitação confirmada pelos docs oficiais

A API pública **NÃO tem endpoint pra criar orçamento** (só `GET /bud/budgets/list` pra listar). Esta função entrega o **Plano A híbrido**:

```
Bot faz (automatizado):                            Usuário faz (manual, 2 min):
  ✓ Cria pasta no MyBase                  →    ✓ Cria orçamento novo
  ✓ Cria composições próprias do edital   →    ✓ Aponta pra pasta criada
  ✓ Adiciona sub-itens (com bank+code)    →    ✓ Importa todas as composições
  ✓ Atualiza orcafascio_composition_id           ✓ Pronto
```

## Pré-requisitos

1. **Credencial Orçafascio cadastrada no Vault**:
   ```sql
   SELECT vault.create_secret('SEU_SECRET_TOKEN', 'orcafascio_pavcon_api');
   INSERT INTO api_credentials (owner_id, escopo, provider, vault_secret_id, metadata)
   VALUES (
     (SELECT id FROM profiles WHERE role = 'admin' LIMIT 1),
     'organizacional', 'orcafascio',
     '<UUID_DO_VAULT>',
     '{"email":"<seu-email>", "auth_type":"api"}'::jsonb
   );
   ```

2. **Licitação extraída e revisada** (status `aguardando_revisao_humana` ou `criando_composicoes_edital`)

3. **Composições próprias presentes** em `composicoes_extraidas` com `fonte='PROPRIA'`

## Entrada

```jsonc
POST /functions/v1/orcafascio-cadastrar-edital
Authorization: Bearer <JWT do usuário Pavcon>

{
  "licitacao_id": "uuid",
  "credential_id": "uuid",
  "force_relog": false,
  "trace_id": "uuid"
}
```

## Resposta (200)

```json
{
  "ok": true,
  "grupo_id": "660ebdaef43197333d899033",
  "grupo_descricao": "EDITAL / CSPII-2026-001 / Pedro II / PI",
  "composicoes_criadas": 24,
  "composicoes_puladas": 1,
  "itens_adicionados": 134,
  "warnings": [],
  "proximo_passo": "No Orçafascio: crie um novo Orçamento e selecione a pasta criada pra importar as composições."
}
```

## Idempotência

A função é segura pra retry:
- Composições com `orcafascio_composition_id` já preenchido são **puladas** (`composicoes_puladas`)
- Permite chamar de novo se algumas falharam (em `warnings`)

Se quiser reprocessar do zero, zere o campo:
```sql
UPDATE composicoes_extraidas
SET orcafascio_composition_id = NULL
WHERE licitacao_id = '<uuid>';
```

## Limitações conhecidas

| Item | Status |
|---|---|
| Cadastrar composições próprias com sub-itens SINAPI/SEINFRA/ORSE | ✅ |
| Cadastrar insumos próprios novos (sem código SINAPI) | ⏳ — atualmente só refencia. Se o edital tiver insumo PRÓPRIO **novo**, adicionar manualmente no MyBase antes |
| Criar o orçamento em si | ❌ API pública não suporta. Usuário cria manual |
| Definir BDI / leis sociais | ❌ idem |

## Mapeamento

| Coluna `composicoes_extraidas` | Campo Orçafascio |
|---|---|
| `codigo` (ou `item_codigo`) | `code` |
| `descricao` | `description` |
| `unidade` | `unit` |
| `licitacoes.uf` | `local` |
| (default genérico) | `type = "PARE"`, `rounding_type = 2`, `is_sicro = false` |

| Coluna `composicao_propria_itens` | Campo do item Orçafascio |
|---|---|
| `fonte` → mapeada | `bank` (SINAPI, SBC, SICRO, ORSE, MYBASE…) |
| `codigo` | `code` |
| `coeficiente` | `qty` |

## Deploy

```powershell
npx supabase functions deploy orcafascio-cadastrar-edital
```
