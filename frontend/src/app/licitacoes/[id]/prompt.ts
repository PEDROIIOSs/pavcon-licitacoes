// Prompt usado pelas extrações manuais (NotebookLM, Claude Code).
// Compartilhado entre o modal e o panel pra não duplicar.

export const EXTRACTION_PROMPT = `Você é um extrator estruturado de planilhas orçamentárias de editais brasileiros de obras públicas.

OBJETIVO: ler o(s) PDF(s) anexado(s) e devolver UM ÚNICO objeto JSON exatamente no schema abaixo. NÃO escreva nada antes ou depois do JSON.

SCHEMA:
{
  "cabecalho": {
    "orgao": string,
    "objeto": string,
    "municipio": string,
    "uf": string,                              // 2 letras (PI, SP, ...)
    "numero_edital": string | null,
    "data_base_descricao": string | null,
    "bases_utilizadas": string[],              // ["SINAPI","SEINFRA","ORSE",...]
    "com_desoneracao": boolean | null,
    "leis_sociais_percentual": number | null,
    "bdi_percentual": number | null
  },
  "itens": [
    {
      "item_codigo": string,                   // ex: "5.1.5"
      "nivel": number,
      "pai": string | null,                    // pai do item, sem o último ".X"
      "tipo": "grupo" | "servico",
      "codigo": string | null,                 // SINAPI/SEINFRA/ORSE ou null
      "fonte": "SINAPI"|"SICRO"|"SEINFRA"|"ORSE"|"SBC"|"PROPRIA"|"OUTRA"|null,
      "descricao": string,
      "unidade": string | null,                // M, M2, KG, CJ, UN, etc.
      "quantidade": number | null,
      "preco_unitario_sem_bdi": number | null,
      "preco_unitario_com_bdi": number | null,
      "preco_total": number | null,
      "composicao_propria": {                  // SOMENTE quando fonte = "PROPRIA"
        "itens": [
          {
            "classe": "INSUMO"|"COMPOSICAO"|"MAT"|"EQUIPAMENTO",
            "codigo": string | null,
            "fonte": "SINAPI"|"SICRO"|"SEINFRA"|"ORSE"|"SBC"|"PROPRIA"|"OUTRA",
            "descricao": string,
            "unidade": string | null,
            "coeficiente": number,
            "preco_unitario": number | null
          }
        ]
      }
    }
  ]
}

REGRAS:
- "tipo=grupo" pra itens agregadores (sem qtd/preço), "tipo=servico" pra linhas com quantidade.
- Hierarquia inferida pelo número: "1" → nível 1, "1.1" → nível 2; pai("1.1.5") = "1.1".
- composicao_propria SÓ existe quando fonte="PROPRIA".
- Números com ponto decimal (não vírgula).

FORMATO DA RESPOSTA:
- Coloque o JSON inteiro DENTRO de UM bloco \`\`\`json ... \`\`\` (markdown fenced code).
- Isso vai virar um Artifact no Claude.ai (painel lateral) com botão de download direto.
- O usuário pode usar o botão "Copy code" do bloco ou baixar o arquivo \`.json\` pelo Artifact — sem precisar selecionar texto manualmente.
- NÃO escreva nada antes ou depois do bloco \`\`\`json. Sem comentários, sem explicações.
`;

export const NOTEBOOKLM_URL = 'https://notebooklm.google.com/';

// Claude.ai aceita ?q= pra pre-preencher a mensagem em chat novo.
// O usuário ainda precisa anexar o PDF e enviar.
export function claudeNewChatUrl(prompt: string): string {
  return `https://claude.ai/new?q=${encodeURIComponent(prompt)}`;
}
