# Edge Function: `orcafascio-web-auth` (Plano B')

Autentica no Orçafascio via **UI web** (login com email + senha + CSRF) e cacheia o cookie `_orcafascio_session` em `orcafascio_sessoes` pra reuso por outras Edge Functions que falam com endpoints `/v2023/*`.

## Quando usar

Use esta função (e não `orcafascio-auth`) quando você precisa criar/editar **orçamentos** no Orçafascio. A API pública (`api.orcafascio.com/api/v1/`) não tem esses endpoints — eles só estão expostos sob `app.orcafascio.com/v2023/*` com autenticação por sessão.

## Como cadastrar a credencial web

⚠️ Diferente da credencial de API: aqui o segredo no Vault é a **senha de login** do Orçafascio (não o `secret_token`).

```sql
-- 1) Salva a SENHA no Vault
SELECT vault.create_secret('SUA_SENHA_DE_LOGIN_AQUI', 'orcafascio_pavcon_web');
-- → copie o UUID retornado

-- 2) Cria credencial com auth_type='web'
INSERT INTO api_credentials (owner_id, escopo, provider, vault_secret_id, metadata)
VALUES (
  (SELECT id FROM profiles WHERE role = 'admin' LIMIT 1),
  'organizacional',
  'orcafascio',
  '<UUID_DO_PASSO_1>',
  '{
    "email": "licitacao@pavconconstrutora.com.br",
    "auth_type": "web"
  }'::jsonb
);
```

Você pode ter **duas credenciais `orcafascio` ativas ao mesmo tempo**:
- uma com `auth_type='api'` (usa `secret_token`, vai pra `orcafascio-auth`)
- outra com `auth_type='web'` (usa senha, vai pra `orcafascio-web-auth`)

A constraint `UNIQUE (owner_id, provider, escopo)` em `api_credentials` impede duas iguais. Se você quiser as duas, uma como organizacional e outra como pessoal, ou crie usuários distintos.

## Entrada

```jsonc
POST /functions/v1/orcafascio-web-auth
Authorization: Bearer <JWT do usuário Pavcon>

{
  "credential_id": "uuid-da-credencial",
  "force_refresh": false,
  "trace_id": "uuid"
}
```

## Resposta (200)

```json
{
  "ok": true,
  "cached": false,
  "expires_at": "2026-05-08T03:24:41Z",
  "email": "licitacao@pavconconstrutora.com.br",
  "session_value_preview": "cTd6c2N…"
}
```

> O cookie completo **não vai pra resposta** — fica só em `orcafascio_sessoes`. Outras Edge Functions usam `_shared/orcafascio-web.ts:authenticateOrcafascioWeb()` pra recuperá-lo via cache + RPC.

## Erros

| status | code                       | razão                                                          |
| ------ | -------------------------- | -------------------------------------------------------------- |
| 400    | credential_wrong_auth_type | Credencial não tem `metadata.auth_type='web'`                  |
| 422    | login_rejected             | Email/senha errados (login redirecionou pra `/login`)          |
| 502    | csrf_not_found             | `/login/new` não retornou `<meta csrf-token>` (HTML mudou?)    |
| 502    | login_unreachable          | Falha de rede com `app.orcafascio.com`                         |
| 502    | login_unexpected           | Status diferente de 302 ou redirect estranho                   |

## Trade-offs (vs `orcafascio-auth`)

| | API pública (`orcafascio-auth`) | Web (`orcafascio-web-auth`) |
|---|---|---|
| Endpoints disponíveis | Limitado (sem create/edit de orçamento) | **Tudo o que a UI faz** |
| TTL da sessão | 24h (JWT) | ~4h (cookie de sessão) |
| Estabilidade | API documentada | **Não documentada — pode mudar** |
| Secret armazenado | `secret_token` | **Senha de login** (mais sensível) |
| Risco de detecção | Baixo | Médio (parece automação) |

## Deploy

```powershell
npx supabase functions deploy orcafascio-web-auth
```

## Próximos passos

Esta função é o pré-requisito pra `orcafascio-cadastrar-edital` (ainda em construção). Quando ela existir, o fluxo será:

```
1. Frontend chama orcafascio-cadastrar-edital(licitacao_id, credential_web_id)
2. cadastrar-edital chama authenticateOrcafascioWeb() → cookie do cache
3. Pra cada item de composicoes_extraidas, POST /v2023/bud/budgets/{id}/items/
4. Atualiza composicoes_extraidas.orcafascio_resource_id
5. Transição licitacao → criando_orcamento_base → fase1_concluida
```
