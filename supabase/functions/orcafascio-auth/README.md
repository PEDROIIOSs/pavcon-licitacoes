# Edge Function: `orcafascio-auth`

Obtém um `auth_token` válido do Orçafascio a partir de uma credencial cadastrada em `api_credentials` (com `secret_token` no Vault).

## Fluxo

1. Valida o JWT do chamador (precisa ser um usuário autenticado da Pavcon).
2. Lê `api_credentials` e checa autorização (escopo `organizacional` permite qualquer usuário ativo; `pessoal` só permite o `owner_id`).
3. Se `force_refresh != true`, tenta cache via `get_orcafascio_active_session(credential_id)`. Sessão é considerada válida quando faltam mais de 5 minutos pra expirar.
4. Caso contrário, descriptografa o `secret_token` via `read_vault_secret(vault_secret_id)` e faz `POST https://api.orcafascio.com/api/v1/login/authenticate_user` com `{ email, secret_token }`.
5. Persiste `orcafascio_sessoes` com TTL de 23h50min via `upsert_orcafascio_sessao`.
6. Toda a chamada vai pra `audit_log_integracoes` (com tokens e senhas mascarados).

## Entrada

```jsonc
POST /functions/v1/orcafascio-auth
Authorization: Bearer <JWT do usuário Pavcon>
Content-Type: application/json

{
  "credential_id": "uuid-da-api_credentials",  // obrigatório
  "force_refresh": false,                       // opcional, default false
  "trace_id": "uuid"                            // opcional, p/ correlacionar logs
}
```

## Resposta (200)

```json
{
  "auth_token": "eyJ...",
  "expires_at": "2026-05-08T14:42:00.000Z",
  "cached": true,
  "orcafascio_user_id": "638...",
  "orcafascio_company_id": "638...",
  "orcafascio_department_id": "638...",
  "email": "licitacao@pavconconstrutora.com.br",
  "company_name": "PAVCON CONSTRUTORA",
  "trace_id": "..."
}
```

## Erros

| status | razão                                                              |
| ------ | ------------------------------------------------------------------ |
| 400    | body inválido / `credential_id` ausente / provider errado          |
| 401    | sem JWT (chamador não autenticado)                                 |
| 403    | credencial pessoal de outro usuário, ou credencial inativa         |
| 404    | credencial não encontrada                                          |
| 405    | método ≠ POST                                                      |
| 422    | Orçafascio rejeitou as credenciais (cache é invalidado)            |
| 500    | erro interno (ler credencial, ler Vault, etc.)                     |
| 502    | erro de rede com o Orçafascio, ou resposta inesperada              |

## Como cadastrar a credencial Orçafascio (uma vez)

No SQL Editor do Supabase, **logado como admin**:

```sql
-- 1) Salva o secret_token (NÃO a senha) no Vault e captura o UUID retornado:
SELECT vault.create_secret(
  'COLE_AQUI_O_SECRET_TOKEN_DO_ORCAFASCIO',
  'orcafascio_pavcon_main'
);
-- → retorna um UUID, copie

-- 2) Cria a credencial apontando para esse UUID, com email no metadata:
INSERT INTO api_credentials (owner_id, escopo, provider, vault_secret_id, metadata)
VALUES (
  (SELECT id FROM profiles WHERE role = 'admin' LIMIT 1),
  'organizacional',
  'orcafascio',
  '<UUID_RETORNADO_NO_PASSO_1>',
  '{"email": "licitacao@pavconconstrutora.com.br"}'::jsonb
)
RETURNING id;
-- → o id retornado é o credential_id que vai no body da Edge Function
```

> **Atenção:** o `secret_token` é diferente da **senha de login**. Localize-o
> no painel do Orçafascio (geralmente em "Perfil" → "API"). Nunca cole a senha
> aqui — a Edge Function não vai conseguir autenticar com ela.

## Testando localmente

Pré-requisito: Deno instalado (`https://deno.com`).

```bash
# Na raiz do projeto:
supabase functions serve --env-file ./supabase/functions/.env

# Em outro terminal — primeiro pegue o JWT de um usuário:
TOKEN="<jwt-de-um-usuario-via-supabase.auth.signInWithPassword>"
CRED_ID="<uuid-da-credencial>"

curl -X POST http://127.0.0.1:54321/functions/v1/orcafascio-auth \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"credential_id\":\"$CRED_ID\"}"
```

## Deploy

```bash
npm run fn:deploy:auth
# equivalente a: supabase functions deploy orcafascio-auth
```

Variáveis de ambiente necessárias no projeto (já presentes em projetos
Supabase por padrão; verifique em **Project Settings → Functions → Secrets**):

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

## Notas de implementação

- **Mapeamento de campos da resposta do Orçafascio** é feito com fallbacks
  (`user._id` ou `user.id` ou `user_id`). A primeira chamada real vai expor o
  shape exato — ajuste em `index.ts` se algum campo vier vazio.
- **Mascaramento de segredos**: `audit.ts` esconde valores em `secret_token`,
  `auth_token`, `password`, `api_key`, `authorization` antes de gravar no log.
- **TTL de sessão**: 23h50min (margem de 10 min sobre as 24h teóricas).
- **Bypass de cache**: passe `force_refresh: true` quando precisar re-logar
  (ex.: depois de uma 401 em outra Edge Function).
