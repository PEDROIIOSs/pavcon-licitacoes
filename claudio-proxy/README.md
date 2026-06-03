# Cláudio Proxy 🤖

Ponte local entre o **Cláudio** (Edge Function do PavCon no Supabase) e o **Claude Code CLI** rodando na sua máquina com subscription Max.

```
PavCon Vercel → Supabase Edge Function → Cloudflare Tunnel → SEU PC (proxy) → Claude Code Max
```

A subscription Max é usada automaticamente, sem precisar de ANTHROPIC_API_KEY separada.

## Pré-requisitos

1. **Node.js 18+** — https://nodejs.org
2. **Claude Code instalado e logado** — `claude login` (já fez)
3. **cloudflared** (Cloudflare Tunnel client) — instalado abaixo

---

## Setup (5 passos, ~10 min)

### 1. Instalar dependências do proxy

```bash
cd claudio-proxy
npm install
```

### 2. Gerar um token de segurança

Pra evitar que qualquer um abuse do seu Claude Code via URL pública. Pode ser qualquer string aleatória — gera assim:

```bash
# Windows PowerShell
[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))

# Mac/Linux
openssl rand -base64 32
```

Copia o token gerado (vai usar nos passos 3 e 5).

### 3. Rodar o proxy local

```bash
# Windows PowerShell
$env:CLAUDIO_PROXY_TOKEN="cole-aqui-o-token-do-passo-2"
npm start

# Mac/Linux / Git Bash
CLAUDIO_PROXY_TOKEN="cole-aqui-o-token-do-passo-2" npm start
```

> **Com acesso ao repositório**: o Claude Code agora roda dentro do diretório do projeto (`../` relativo ao `claudio-proxy/`). Ele pode ler, editar e corrigir arquivos automaticamente.
>
> Para apontar pra um repositório diferente: `REPO_PATH=/caminho/do/repo npm start`

Deve aparecer:
```
╔════════════════════════════════════════════════════════════╗
║                    🤖 Cláudio Proxy                         ║
╠════════════════════════════════════════════════════════════╣
║  Porta: 3001                                                ║
║  CLI:   claude                                              ║
║  Auth:  token configurado                                   ║
╠════════════════════════════════════════════════════════════╣
║  Healthcheck: http://localhost:3001/health                  ║
║  Chat:        POST http://localhost:3001/chat               ║
╚════════════════════════════════════════════════════════════╝
```

Teste em outro terminal:
```bash
curl http://localhost:3001/health
# Deve responder: {"ok":true,"claude_cli":"disponível",...}
```

### 4. Expor publicamente via Cloudflare Tunnel

Cloudflare Tunnel é **grátis** e dá uma URL pública estável que aponta pro seu localhost.

#### Instalar cloudflared

**Windows** (PowerShell como admin):
```powershell
winget install --id Cloudflare.cloudflared
```

**Mac**:
```bash
brew install cloudflared
```

**Linux**:
```bash
# Baixe o binário em https://github.com/cloudflare/cloudflared/releases
```

#### Abrir tunnel

Em outro terminal (deixa o proxy do passo 3 rodando):

```bash
cloudflared tunnel --url http://localhost:3001
```

Vai aparecer algo tipo:
```
Your quick Tunnel has been created! Visit it at:
https://random-words-1234.trycloudflare.com
```

**Copia essa URL** — é a sua URL pública do Cláudio.

### 5. Setar a URL no Supabase

Me passa a URL e o token do passo 2 que eu seto pra você via API. Ou faz manual:

```bash
supabase secrets set \
  CLAUDIO_PROXY_URL=https://random-words-1234.trycloudflare.com \
  CLAUDIO_PROXY_TOKEN=cole-aqui-o-token-do-passo-2 \
  --project-ref cwgjjjlyccgivscngzgz
```

Depois redeploy:
```bash
supabase functions deploy claudio-chat --project-ref cwgjjjlyccgivscngzgz
```

### Pronto! 🎉

Abre a licitação no PavCon, click no botão flutuante do Cláudio, aba **💬 Conversar**, e pergunta qualquer coisa. Ele vai chamar o Claude Code da sua subscription Max.

---

## Como manter rodando

O proxy + tunnel precisam estar **sempre rodando** pra Cláudio responder.

**Opção A — manual**: deixa os 2 terminais abertos quando vai usar.

**Opção B — Windows como serviço** (PM2):
```bash
npm install -g pm2
pm2 start server.js --name claudio-proxy
pm2 start "cloudflared tunnel --url http://localhost:3001" --name claudio-tunnel
pm2 save
pm2 startup  # configura pra iniciar com o Windows
```

**Opção C — Cloudflare Tunnel permanente** (URL fixa):
Tunnel quick é temporário e a URL muda quando você reinicia. Pra URL fixa, registra no Cloudflare:
```bash
cloudflared tunnel login          # OAuth com sua conta CF (grátis)
cloudflared tunnel create claudio
cloudflared tunnel route dns claudio claudio.seudominio.com
cloudflared tunnel run claudio
```

---

## Troubleshooting

### "claude: command not found"

Claude Code não está no PATH. Confirma com:
```bash
claude --version
```

Se não responde, instala/reinstala: https://docs.claude.com/en/docs/claude-code/installation

Ou ajusta o caminho:
```bash
CLAUDE_BIN=/caminho/completo/pra/claude npm start
```

### "Não estou logado no Claude Code"

```bash
claude login
```

### Resposta vazia ou timeout

- Verifica se sua subscription Max está ativa
- Aumenta timeout: `CLAUDE_TIMEOUT_MS=300000 npm start` (5 min)
- Olha os logs do proxy no terminal pra ver o erro do CLI

### "Proxy Cláudio 502"

Geralmente significa que o Cláudio na nuvem não consegue chegar no seu PC:
1. Confirma que o proxy está rodando (passo 3)
2. Confirma que o tunnel está ativo (passo 4)
3. Testa a URL pública: `curl https://random-words-1234.trycloudflare.com/health` deve retornar `ok: true`

### Quanto custa?

- **Cloudflare Tunnel**: grátis (sem limite de bandwidth)
- **Subscription Max**: você já paga
- **Adicional**: zero

---

## Limitações vs API direta

| | Via Proxy Max | Via API Anthropic |
|---|---|---|
| Custo extra | $0 | ~$0.05/conversa |
| Latência | +1-3s (proxy + tunnel) | Direto |
| Tool use | XML tags (workaround) | Estruturado nativo |
| Disponibilidade | Quando seu PC está ligado | 24/7 |
| Setup | Esse README | 1 comando |

Se um dia quiser migrar pra API direta, só setar `ANTHROPIC_API_KEY` no Supabase — o `CLAUDIO_PROXY_URL` é prioritário, então remove esse pra trocar.
