# Pavcon — Sistema de Automação de Licitações

Aplicação web (Agente de IA) para automatizar a criação e readequação de orçamentos para licitações públicas, com integração ao **Orçafascio**, extração via **Gemini** (PDFs/OCR) e análise via **Claude Opus**.

## Estrutura do projeto

```
pavcon-licitacoes/
├── README.md                                   ← este arquivo
├── package.json                                ← Supabase CLI como devDep
├── .env.example                                ← variáveis (copie p/ .env)
├── .gitignore
├── docs/
│   └── ARQUITETURA.md                          ← visão geral, fluxos, decisões
└── supabase/
    ├── config.toml                             ← gerado por `supabase init`
    ├── migrations/
    │   ├── 20260507000001_extensions_and_types.sql   ← extensões + ENUMs
    │   ├── 20260507000002_tables.sql                 ← tabelas
    │   ├── 20260507000003_indexes.sql                ← índices
    │   ├── 20260507000004_functions_triggers.sql     ← state machine + helpers
    │   ├── 20260507000005_rls_policies.sql           ← Row Level Security
    │   └── 20260507000006_edge_function_helpers.sql  ← RPCs p/ Vault + sessões
    ├── seed.sql                                ← dados de teste (CSPII Pedro II)
    └── functions/
        ├── _shared/                            ← cors, supabase, audit, json
        └── orcafascio-auth/                    ← 1ª Edge Function (autenticação)
            ├── index.ts
            ├── deno.json
            └── README.md
```

## Pré-requisitos

- **Node.js** >= 20
- **Supabase CLI** (`npm install -g supabase`)
- Conta no [Supabase](https://supabase.com) — pode usar o tier gratuito para começar
- Acesso ao Orçafascio (email + secret_token)
- API key da Anthropic (Claude) e do Google AI Studio (Gemini)

## Como aplicar as migrations

> O Supabase CLI já está instalado como devDependency neste projeto.
> Use `npx supabase ...` ou os atalhos do `package.json` (`npm run db:push`, etc.).

### Opção A — Projeto Supabase remoto (recomendado para Pavcon)

O projeto remoto já existe: **`cwgjjjlyccgivscngzgz`**.

```powershell
# 1. (uma vez) Crie um Personal Access Token em
#    https://supabase.com/dashboard/account/tokens
#    e exporte como variável:
$env:SUPABASE_ACCESS_TOKEN = "sbp_..."

# 2. Linkar (vai pedir a senha do banco se não estiver no env)
$env:SUPABASE_DB_PASSWORD = "<senha-do-banco>"
npm run link

# 3. Aplicar todas as migrations
npm run db:push

# 4. (Opcional) Rodar o seed — só após criar 1 usuário em Auth → Users
#    Cole o conteúdo de supabase/seed.sql no SQL Editor do dashboard.
```

### Opção B — Desenvolvimento local

```bash
# 1. Iniciar Supabase local (precisa do Docker rodando)
supabase start

# 2. As migrations são aplicadas automaticamente
# 3. O seed.sql é executado automaticamente após as migrations
```

Ao terminar, acesse o Studio em `http://localhost:54323`.

### Opção C — Via SQL Editor do Supabase (manual)

Cole cada arquivo da pasta `supabase/migrations/` na **mesma ordem numérica** no SQL Editor do dashboard. Em seguida, cole `supabase/seed.sql` (após criar pelo menos um usuário em **Auth → Users**).

## Configurando credenciais externas (Vault)

Após aplicar as migrations, registre as credenciais externas. **Nunca cole tokens em texto puro em tabelas regulares** — use o Vault:

```sql
-- Exemplo: cadastrar token Orçafascio (rodar como admin no SQL Editor)
SELECT vault.create_secret('SEU_SECRET_TOKEN_ORCAFASCIO', 'orcafascio_main');

-- Pegue o UUID retornado e use em api_credentials:
INSERT INTO api_credentials (owner_id, escopo, provider, vault_secret_id, metadata)
VALUES (
  (SELECT id FROM profiles WHERE role = 'admin' LIMIT 1),
  'organizacional',
  'orcafascio',
  '<UUID_RETORNADO_PELO_VAULT>',
  '{"email": "seu-email-orcafascio@pavcon.com.br"}'::jsonb
);
```

Repita para `anthropic`, `gemini` e (opcionalmente) `voyage` para embeddings.

## Próximos passos no Claude Code

Sugestão de próximos prompts para o Claude Code, em ordem de prioridade:

### 1. ✅ Edge Function de autenticação Orçafascio — **implementada**

Pasta: [supabase/functions/orcafascio-auth/](supabase/functions/orcafascio-auth/) — ver [README dela](supabase/functions/orcafascio-auth/README.md) para uso, deploy e como cadastrar a credencial no Vault.

Deploy:
```powershell
npm run fn:deploy:auth
```

### 2. Edge Function de sincronização de grupos

> *"Crie a Edge Function `supabase/functions/orcafascio-sync-grupos/` que chama `GET /v1/base/mybase/groups` no Orçafascio (usando o helper de auth da Função 1) e popula `orcafascio_grupos_cache`."*

### 3. Edge Function de upload + extração

> *"Crie a Edge Function `supabase/functions/extracao-edital/` que: (a) recebe arquivo_id, (b) baixa o PDF do Storage, (c) envia para Gemini 2.5 Pro com o prompt versão `pavcon-extracao-edital-v1` (devolver JSON estruturado seguindo o schema documentado em docs/ARQUITETURA.md), (d) salva resultado em extracoes_ocr e composicoes_extraidas."*

### 4. Frontend Next.js

> *"Inicialize um app Next.js 15 com App Router, Tailwind CSS, shadcn/ui, e @supabase/ssr. Configure auth com magic link. Crie a tela inicial: dashboard listando licitações via vw_dashboard_licitacoes, com filtros por status e badge para 'aguarda ação humana'."*

### 5. Tela de upload e revisão

> *"Crie a tela `/licitacoes/nova` com upload de PDF, e a tela `/licitacoes/[id]` mostrando o status da licitação na máquina de estados. Quando estado = 'aguardando_revisao_humana', exibir o JSON extraído em formato editável (tabela) para revisão."*

## Validações rápidas após aplicar as migrations

```sql
-- Devem retornar 14 (todas as tabelas criadas)
SELECT count(*) FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE';

-- Devem retornar todos os ENUMs
SELECT typname FROM pg_type WHERE typtype = 'e' AND typname LIKE '%status%' OR typname LIKE '%role%';

-- RLS deve estar habilitado em todas as tabelas
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname = 'public' ORDER BY tablename;

-- Após o seed, deve retornar 1 licitação em fase1_concluida
SELECT id, titulo, status FROM licitacoes;

-- Testa a view do dashboard
SELECT * FROM vw_dashboard_licitacoes;
```

## Bloqueio conhecido

⚠️ **A API pública do Orçafascio NÃO documenta endpoints para criar/editar orçamentos** (apenas listar). O bloco do schema referente à criação do "Orçamento Base" e da "Proposta Readequada" está pronto, mas a Edge Function correspondente depende da resposta do suporte Orçafascio sobre:

1. Endpoint para criar orçamento via API
2. Endpoint para adicionar composições/serviços ao orçamento com quantidade
3. Endpoint para duplicar orçamento aplicando desconto/readequação

**Plano B**: gerar todas as composições/insumos via API, e o orçamentista finaliza com poucos cliques no Orçafascio. **Plano C**: automação via Playwright como fallback.

## Stack alvo

- **Frontend**: Next.js 15 + Tailwind + shadcn/ui
- **Backend**: Supabase (Postgres + Auth + Storage + Edge Functions Deno)
- **LLMs**:
  - Gemini 2.5 Pro → OCR/Vision (PDFs longos)
  - Claude Opus 4.7 → Análise semântica, sugestão de BDI, normalização
  - Voyage AI ou OpenAI → embeddings para busca histórica
- **Integração**: API REST do Orçafascio (com cache de JWT 24h)

Veja `docs/ARQUITETURA.md` para detalhes do design.
