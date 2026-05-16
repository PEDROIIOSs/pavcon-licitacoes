# API interna `/v2023/` do Orçafascio — endpoints mapeados

> Reverse-engineering feito em 2026-05-16 via Chrome MCP (Claude in Chrome) + DevTools Network. Esta API **não é pública** — está sujeita a mudar sem aviso. Sempre validar antes de operações em produção.

## Como autenticar

`POST https://app.orcafascio.com/login` com `email` + `senha` (form-urlencoded).
Resposta inclui `Set-Cookie: _orcafascio_session=...` que precisa ser enviado em todas as chamadas subsequentes. TTL típico ~4h.

Helper já implementado em `supabase/functions/_shared/orcafascio-web.ts` (Edge Function `orcafascio-web-auth`).

## Headers comuns em todos os requests autenticados

```
Cookie: _orcafascio_session=<valor>
X-Requested-With: XMLHttpRequest
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
Origin: https://app.orcafascio.com
Referer: https://app.orcafascio.com/orc/orcamentos/{id}
```

Plus o **`authenticity_token`** (CSRF) precisa ir no body — obtido do meta tag `<meta name="csrf-token" content="...">` da página HTML.

## Endpoints

### 1. Criar orçamento

```
POST https://app.orcafascio.com/orc/orcamentos
Content-Type: application/x-www-form-urlencoded
```

**ATENÇÃO**: este NÃO usa `/v2023/` no path — só `/orc/orcamentos`.

Body (Rails strong_params com prefixo `orc_orcamento`):
```
authenticity_token=<CSRF>
&orc_orcamento[version_2023]=1
&orc_orcamento[codigo]=Nome curto do orçamento
&orc_orcamento[descricao]=Descrição completa
&orc_orcamento[cliente_id]=<id ou vazio>
&orc_orcamento[standard_category_name]=Infraestruturas Esportivas - Reforma
&orc_orcamento[custom_category_name]=
&orc_orcamento[validity]=
&orc_orcamento[insumos_zerados]=0
&orc_orcamento[mask_itemization]=1
&orc_orcamento[licitacao]=0
&orc_orcamento[rounding_option]=1   (1, 2 ou 0)
... (mais campos não capturados — total 21)
```

Resposta: redirect 302 para `/orc/orcamentos/{novo_budget_id}/new_passo_2`. O `budget_id` está na URL de destino.

### 2. Editar cabeçalho do orçamento

```
PATCH https://app.orcafascio.com/v2023/orc/orcamentos/{budget_id}
Content-Type: application/x-www-form-urlencoded
```

Body: mesmos campos `orc_orcamento[...]` do CREATE, + `_method=patch`.

### 3. Atualizar BDI

```
POST https://app.orcafascio.com/v2023/orc/orcamentos/update_bdi?id={budget_id}
```

Body:
```
authenticity_token=<CSRF>
&no_final=...
&bdi_manual=22.0
&base_bdi=...
```

### 4. Atualizar leis sociais (encargos)

```
POST https://app.orcafascio.com/v2023/orc/orcamentos/update_leis_sociais?id={budget_id}
```

Body:
```
authenticity_token=<CSRF>
&desonerado=false
&charge_manual=...
&charge_hourly=113.78
&charge_monthly=...
&horista=...
&mensalista=...
```

### 5. Atualizar bases (bancos SINAPI/SBC/SICRO/ORSE)

```
POST https://app.orcafascio.com/v2023/bud/budgets/{budget_id}/update_bases
```

Body:
```
authenticity_token=<CSRF>
&atualizar_composicoes=true
&SINAPI_exibir_relatorio=true
&SINAPI_estado=PI
&SINAPI_data=03/2026
&SINAPI_rounding_option=...
&SBC_exibir_relatorio=...
&SBC_estado=...
... (todos os bancos)
```

### 6. ⭐ Adicionar items ao orçamento (etapas + composições) ⭐

```
POST https://app.orcafascio.com/v2023/bud/budgets/{budget_id}/items/
Content-Type: application/x-www-form-urlencoded
```

**Endpoint mais importante**: aceita BATCH de N itens com `new_items[i][...]`. Cria etapas, sub-etapas e composições de uma vez.

#### Body — adicionar 1 composição (SINAPI):
```
authenticity_token=<CSRF>
&new_items[0][kind]=composition
&new_items[0][itemization]=3.2                ← código hierárquico do item
&new_items[0][base]=SINAPI                    ← banco fonte
&new_items[0][base_id]=<uuid-v4>              ← UUID gerado client-side
&new_items[0][public_banco_id]=               ← vazio quando SINAPI/SBC; preenchido pra MyBase?
&new_items[0][code]=88316                     ← código SINAPI/SBC
&new_items[0][qty]=20
```

#### Body — adicionar 1 etapa (phase):
```
&new_items[0][kind]=phase
&new_items[0][itemization]=4                  ← número da etapa
&new_items[0][descr]=COBERTURA                ← descrição da etapa
&new_items[0][parent_descr]=                  ← vazio pra etapa raiz; preenchido pra sub-etapa
&new_items[0][qty]=1
```

#### Body — batch (etapa + 3 composições):
```
authenticity_token=<CSRF>
&new_items[0][kind]=phase&new_items[0][itemization]=4&new_items[0][descr]=COBERTURA&new_items[0][parent_descr]=&new_items[0][qty]=1
&new_items[1][kind]=composition&new_items[1][itemization]=4.1&new_items[1][base]=SINAPI&new_items[1][base_id]=<uuid>&new_items[1][code]=88316&new_items[1][qty]=10
&new_items[2][kind]=composition&new_items[2][itemization]=4.2&new_items[2][base]=SINAPI&new_items[2][base_id]=<uuid>&new_items[2][code]=88309&new_items[2][qty]=5
&new_items[3][kind]=composition&new_items[3][itemization]=4.3&new_items[3][base]=MYBASE&new_items[3][base_id]=<uuid>&new_items[3][code]=EDIT.PICOS.4.3&new_items[3][qty]=3
```

Resposta: `200 OK` com Content-Type `application/vnd.api+json`. Body ~16 bytes (`{}` ou `{"status":"ok"}`).

### 7. Atualizar endereço da obra

```
POST https://app.orcafascio.com/v2023/orc/orcamentos/updade_endereco?id={budget_id}
```

Body: `orc_endereco[cep], [logradouro], [numero], [complemento], [bairro], [cidade], [estado], [pais]`.

### 8. Atualizar FIT

```
POST https://app.orcafascio.com/v2023/bud/budgets/{budget_id}/update_fit
```

Body: `orc_fit[calculo], [fit_informado], [porcentagem_urbano], [vmd]`.

### 9. Duplicar orçamento

```
POST https://app.orcafascio.com/v2023/orc/orcamentos/copiar?id={budget_id}
```

Body: `descricao=Nome do clone`.

### 10. Buscar substitutos de base

```
GET https://app.orcafascio.com/v2023/orcamentos/{budget_id}/compatibilizacao_de_bases_selecionadar_substitutos?banco=SINAPI
```

### 11. Criar cliente (durante o wizard)

```
POST https://app.orcafascio.com/orc/orcamentos/create_cliente
```

Body: `cliente[pj]=0|1, [nome], [cpf]|[cnpj], [email], [telefone], [end_cep], [end_logradouro], [end_numero], [end_complemento], [end_bairro], [end_cidade], [end_estado]`.

### 12. Sincronizar com MyBase

```
POST https://app.orcafascio.com/v2023/orc/orcamentos/sincronizar_com_base_emp?id={budget_id}
```

Body: `composicao_modelo, composicao_informacao, composicao_codigo, composicao_c2, composicao_descricao, composicao_mao_de_obra, composicao_tipo, composicao_unidade, composicao_observacao, caderno_tecnico`.

## Fluxo recomendado pra criar orçamento via bot

```
1. POST /login                                  ← orcafascio-web-auth (já existe)
   → captura _orcafascio_session cookie

2. GET /orc/orcamentos/new
   → captura CSRF token do <meta name="csrf-token">

3. POST /orc/orcamentos
   → cria budget, captura budget_id da URL de redirect

4. POST /v2023/bud/budgets/{budget_id}/update_bases
   → configura SINAPI/SICRO/ORSE conforme cabecalho do edital

5. POST /v2023/orc/orcamentos/update_bdi?id={budget_id}
   → BDI do edital (ex: 22%)

6. POST /v2023/orc/orcamentos/update_leis_sociais?id={budget_id}
   → encargos sociais (113.78% horista típico)

7. POST /v2023/bud/budgets/{budget_id}/items/  (em batch único)
   → new_items[] com TODAS as etapas, sub-etapas e composições da licitação
   → composições próprias usam base=MYBASE + code=EDIT.PICOS.{item_codigo}
   → composições SINAPI/SBC/SEINFRA/ORSE usam base=<fonte> + code=<código original>

8. UPDATE licitacoes SET status='fase1_concluida'
   → fim da Fase 1 — orçamento criado e populado
```

## Pendências

- [ ] Capturar body completo de POST /orc/orcamentos (atualmente conhecemos 8 dos 21 campos)
- [ ] Confirmar formato do base_id (UUID client-side ou retornado por endpoint?)
- [ ] Confirmar se public_banco_id é obrigatório quando base=MYBASE
- [ ] Mapear erros possíveis (CSRF expirado, sessão expirada, validação)

## Estabilidade / risco

- **Endpoints sob `/v2023/`** podem mudar a qualquer release do Orçafascio
- **CSRF token** rotaciona — precisamos buscar antes de cada batch de chamadas
- **Session cookie** TTL ~4h (helper já trata renovação)
- Em caso de breakage: voltar ao plano híbrido (cadastrar só MyBase + criar orçamento manual)
