# Edge Function: `orcafascio-sync-grupos`

Sincroniza os grupos (pastas) do MyBase do Orçafascio para `orcafascio_grupos_cache`. Roda autenticando via `authenticateOrcafascio()` (cache de sessão de 24h) e fazendo `GET /api/v1/base/mybase/groups`.

## Entrada

```jsonc
POST /functions/v1/orcafascio-sync-grupos
Authorization: Bearer <JWT do usuário Pavcon>

{
  "credential_id": "uuid-da-credencial-orcafascio",
  "trace_id": "uuid"   // opcional
}
```

## Resposta (200)

```json
{
  "fetched": 12,
  "upserted": 12,
  "removed": 0,
  "trace_id": "..."
}
```

## Quando rodar

- **On-demand** quando o usuário clicar em "Atualizar grupos" no frontend
- **Agendado** (futuro: pg_cron a cada 6h) pra manter o cache fresco
- Antes da Edge Function `orcafascio-cadastrar-edital` (precisa do `id` do "Setor de Licitação")

## Auto-relogin

Se a chamada retornar 401, a função invalida o cache de sessão e tenta de novo com login fresh. Limite de 1 retry pra evitar loop.

## Erros

| status | razão                                              |
| ------ | -------------------------------------------------- |
| 400    | body inválido / `credential_id` ausente            |
| 401    | sem JWT (chamador não autenticado)                 |
| 403    | credencial pessoal de outro usuário, ou inativa    |
| 404    | credencial não encontrada                          |
| 422    | Orçafascio rejeitou as credenciais                 |
| 502    | Orçafascio inalcançável ou resposta inesperada     |
| 500    | erro interno (Vault, banco, etc.)                  |

## Deploy

```powershell
npx supabase functions deploy orcafascio-sync-grupos
```
