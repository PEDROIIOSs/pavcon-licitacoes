# Arquitetura — Pavcon Licitações

Documento vivo. Registra decisões, fluxos e contratos.

## Visão geral

Sistema interno para automatizar a operação de orçamentos para licitações públicas em duas fases:

- **Fase 1 — Espelhamento do edital**: ler o PDF da planilha orçamentária do órgão, extrair os itens (com Gemini), revisar com o orçamentista, e cadastrar no Orçafascio um orçamento que é cópia fiel do que o órgão publicou.
- **Fase 2 — Proposta Pavcon**: a partir do espelho da Fase 1, gerar a proposta comercial da Pavcon aplicando estratégia escolhida (sem desconto, desconto linear, BDI alterado, etc.).

A Fase 1 entrega valor sozinha. A Fase 2 só roda quando a Pavcon decide submeter a proposta.

## Modelo de dados — visão por contextos

```
┌─────────────────────────────────────────────────────────────┐
│  USUÁRIOS E SEGURANÇA                                       │
│  auth.users → profiles → api_credentials → vault.secrets    │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  CACHE DO ORÇAFASCIO (evita chamadas repetidas + auth)      │
│  orcafascio_sessoes (JWT 24h)                               │
│  orcafascio_grupos_cache (pastas)                           │
│  orcafascio_orcamentos_cache (acervo histórico + embeddings)│
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  OPERACIONAL (uma licitação)                                │
│  licitacoes ─┬─ licitacao_arquivos                          │
│              ├─ extracoes_ocr                               │
│              ├─ composicoes_extraidas ─ composicao_propria_itens │
│              └─ analises_historicas                         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  ACERVO REUTILIZÁVEL                                        │
│  composicoes_edital_sincronizadas                           │
│   (composições próprias já cadastradas no Orçafascio,       │
│    indexadas por hash_assinatura para reuso entre editais)  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  OBSERVABILIDADE E UX                                       │
│  notificacoes (in-app)                                      │
│  audit_log_integracoes (toda chamada externa)               │
└─────────────────────────────────────────────────────────────┘
```

## Máquina de estados

```
rascunho
   │
   ▼
aguardando_extracao  →  extraindo  →  extracao_concluida
                                              │
                                              ▼
                              aguardando_revisao_humana
                                              │
                                              ▼
                            criando_composicoes_edital
                                              │
                                              ▼
                              criando_orcamento_base
                                              │
                                              ▼
                                  ┌─ fase1_concluida ─┐ ★ pausa natural
                                  │                   │
                                  └───────────────────┘
                                              │
                                              ▼ (orçamentista decide propor)
                                   definindo_estrategia
                                              │
                                              ▼
                                    gerando_proposta
                                              │
                                              ▼
                                       finalizado

Estados especiais:
   erro       (a partir de qualquer estado)
   arquivada  (idem)
```

A função `validate_licitacao_status_transition()` (em
`20260507000004_functions_triggers.sql`) impõe as transições válidas via trigger.

## Schema do JSON de extração (alvo do Gemini)

Esse é o formato que o prompt `pavcon-extracao-edital-v1` deve garantir. Validado contra o edital CSPII (Pedro II — PI).

```json
{
  "cabecalho": {
    "orgao": "MUNICÍPIO DE PEDRO II - PI",
    "objeto": "CONSTRUÇÃO DE CAMPO SOCIETY...",
    "municipio": "Pedro II",
    "uf": "PI",
    "numero_edital": "EDITAL-CSPII-2026-001",
    "data_base_descricao": "SINAPI PI 01/2026, SEINFRA CE 28, ORSE SE 01/2026",
    "bases_utilizadas": ["SINAPI", "SEINFRA", "ORSE"],
    "com_desoneracao": false,
    "leis_sociais_percentual": 113.78,
    "bdi_percentual": 22.12
  },
  "itens": [
    {
      "item_codigo": "5.1.5",
      "nivel": 3,
      "pai": "5.1",
      "tipo": "servico",
      "codigo": "COMP11",
      "fonte": "PROPRIA",
      "descricao": "CONJUNTO REFLETOR LED 4 X 200 W ...",
      "unidade": "CJ",
      "quantidade": 1.0,
      "preco_unitario_sem_bdi": null,
      "preco_unitario_com_bdi": null,
      "preco_total": null,
      "composicao_propria": {
        "itens": [
          {
            "classe": "INSUMO",
            "codigo": "436",
            "fonte": "SINAPI",
            "descricao": "PARAFUSO FRANCES M16 EM ACO GALVANIZADO ...",
            "unidade": "UN",
            "coeficiente": 2.0,
            "preco_unitario": 12.13
          }
        ]
      }
    }
  ]
}
```

Notas importantes:

- `tipo` deve ser `grupo` para itens agregadores (sem preço) ou `servico` para linhas com quantidade.
- `composicao_propria` só existe quando `fonte = "PROPRIA"`.
- Preços podem vir nulos para PRÓPRIA quando o edital só dá o total da composição.
- A hierarquia (`item_codigo`, `nivel`, `pai`) precisa ser inferida pelo LLM olhando os números (1, 1.1, 1.1.1, etc.).

## Sincronização com Orçafascio — pseudocódigo

```python
def cadastrar_edital(licitacao_id):
    """Fase 1: espelha o edital no Orçafascio."""

    composicoes = db.composicoes_extraidas.where(licitacao_id=licitacao_id)

    for comp in composicoes:
        if comp.tipo_linha == 'grupo':
            continue  # grupos não viram registro no Orçafascio

        if comp.fonte == 'PROPRIA':
            # Calcula assinatura para detectar reuso
            hash_assin = sha256(
                normalizar_descricao(comp.descricao) + 
                json_canonical(comp.itens_propria)
            )

            cache = db.composicoes_edital_sincronizadas.find(hash_assinatura=hash_assin)
            if cache:
                # Reuso! economia de tempo + chamadas
                comp.orcafascio_composition_id = cache.orcafascio_composition_id
                db.incrementar_reuso_composicao(hash_assin)
            else:
                # Primeiro encontro: precisamos cadastrar
                # 1. Garantir que todos os insumos existem no Orçafascio
                for insumo in comp.itens_propria:
                    if insumo.fonte == 'PROPRIA':
                        # Cadastra novo insumo na MyBase do Orçafascio
                        resp = orcafascio.POST('/v1/mybase/resources', insumo.to_payload())
                        insumo.orcafascio_resource_id = resp.id
                    else:
                        # Busca por código (SINAPI/SEINFRA/ORSE)
                        resp = orcafascio.GET(f'/v1/resources/find_by_code?code={insumo.codigo}')
                        insumo.orcafascio_resource_id = resp.id

                # 2. Cria a composição no Orçafascio
                resp = orcafascio.POST('/v1/mybase/compositions', comp.to_composition_payload())
                comp_id = resp.id

                # 3. Adiciona itens à composição
                orcafascio.POST(f'/v1/mybase/compositions/{comp_id}/items', 
                                comp.itens_propria.to_items_payload())

                # 4. Salva no acervo para próximas reutilizações
                db.composicoes_edital_sincronizadas.create(
                    hash_assinatura=hash_assin,
                    orcafascio_composition_id=comp_id,
                    primeira_licitacao_id=licitacao_id
                )
        else:
            # SINAPI/SEINFRA/ORSE: já existem na base do Orçafascio
            # (assumindo que a Pavcon contratou essas bases)
            pass

    # ⚠️ BLOQUEADO: criar o orçamento em si
    # Aguardando confirmação do suporte Orçafascio sobre o endpoint adequado
    # Plano A: orcafascio.POST('/v1/orcamentos', ...) (se existir)
    # Plano B: pular esta etapa e instruir orçamentista a criar manualmente
    # Plano C: usar Playwright para automatizar a UI

    transition_status(licitacao_id, 'fase1_concluida')
```

## Stack de LLMs

| Função | Provedor | Modelo | Por quê |
|---|---|---|---|
| OCR + extração de PDF | Google | `gemini-2.5-pro` | 1M tokens de contexto, ótimo com tabelas, custo baixo de input |
| Análise semântica + sugestão de BDI | Anthropic | `claude-opus-4-7` | Raciocínio mais robusto para decisões sensíveis |
| Embeddings | Voyage AI | `voyage-3` | Recomendado pela Anthropic, 1024 dims |
| Fallback embeddings | OpenAI | `text-embedding-3-small` | 1536 dims, default do schema |

A escolha de **dimensão 1536** no schema (`embedding_objeto vector(1536)`) é compatível com OpenAI e Voyage. Para usar Gemini embedding-001 nativo (768/3072), basta `ALTER TABLE` antes do uso.

## Decisões arquiteturais registradas

### ADR-001: Separar "execução" de "resultado" em extracoes_ocr

**Contexto**: Uma extração pode falhar e ser reexecutada. Pode também ser revisada pelo humano.

**Decisão**: Manter `json_extraido` (vindo do LLM) e `json_corrigido` (pós-revisão). A aplicação usa `COALESCE(json_corrigido, json_extraido)` ao seguir adiante.

**Consequência**: Histórico completo de qualidade do LLM versus correções humanas. Permite calcular taxa de "extração perfeita" e refinar prompts.

### ADR-002: Acervo de composições reutilizáveis (hash_assinatura)

**Contexto**: O mesmo município (ou municípios diferentes copiando templates) repete composições próprias entre editais.

**Decisão**: Tabela `composicoes_edital_sincronizadas` com `hash_assinatura = SHA256(descricao_normalizada + insumos_canonicos)`. Antes de criar uma composição no Orçafascio, checar reuso.

**Consequência**: Reduz drasticamente chamadas de criação após algumas dezenas de editais processados. Risco: hash ser muito sensível (qualquer diferença → não detecta reuso). Mitigação: função `normalizar_descricao()` no banco.

### ADR-003: Auth do Orçafascio com cache de JWT

**Contexto**: Token expira em 24h. Renovar a cada chamada é desperdício.

**Decisão**: Tabela `orcafascio_sessoes` com `expires_at`. Helper `get_orcafascio_token()` retorna NULL se expirado, e o backend faz login então.

**Consequência**: Latência reduzida. Risco: token revogado pelo Orçafascio sem aviso → tratamento de 401 deve invalidar cache e tentar novamente.

### ADR-004: Embeddings em pgvector (não Pinecone/Weaviate)

**Contexto**: Análise histórica precisa busca por similaridade.

**Decisão**: pgvector dentro do Supabase com índice HNSW.

**Consequência**: Zero dependências externas, zero custo extra, latência baixa (mesma rede do Postgres). Limite prático: ~100k orçamentos antes de precisar reavaliar.

### ADR-005: Single-tenant agora, multi-tenant depois

**Contexto**: A Pavcon é a única empresa que vai usar.

**Decisão**: Sem tabela `organizations`. RLS valida só "usuário ativo". Se o app virar produto SaaS futuramente, adicionar tenant_id em cascata.

**Consequência**: Schema mais simples agora. Migration futura para multi-tenant é trabalhosa, mas previsível.

## Endpoints internos planejados

Ver detalhes em conversas anteriores. Sumário:

| Camada | Endpoint | Status |
|---|---|---|
| Auth | Supabase nativo | ✅ |
| Credenciais | `POST /api/credentials` | A implementar |
| Orçafascio Auth | Edge Function `orcafascio-auth` | A implementar |
| Sincronização grupos | Edge Function `orcafascio-sync-grupos` | A implementar |
| Sincronização histórico | Edge Function `orcafascio-sync-historico` | A implementar |
| Upload edital | `POST /api/licitacoes/:id/arquivos` | A implementar |
| Extração | Edge Function `extracao-edital` | A implementar |
| Revisão humana | `PATCH /api/licitacoes/:id/extracao/:eid/revisao` | A implementar |
| Cadastrar edital no Orçafascio | Edge Function `orcafascio-cadastrar-edital` | ⚠️ Parcialmente bloqueado |
| Análise histórica | Edge Function `analise-historica` | A implementar |
| Gerar proposta Pavcon | Edge Function `gerar-proposta` | ⚠️ Bloqueado |

## Riscos abertos

1. **API do Orçafascio sem endpoints de orçamento** — bloqueio principal. Aguardando suporte.
2. **Custo do Gemini para PDFs longos** — o CSPII tem 120 páginas, custou ~$1.42 simulado. Editais maiores podem subir muito. Monitorar via `extracoes_ocr.custo_usd` desde o dia 1.
3. **Qualidade da extração de tabelas complexas** — algumas planilhas têm células mescladas, hierarquia visual sem indentação clara, etc. Risco mitigado pelo passo `aguardando_revisao_humana`, mas pode atrasar o fluxo se for frequente.
4. **Mudança de UI do Orçafascio** (caso usemos Playwright como Plano C) — automação frágil. Só usar como último recurso.
