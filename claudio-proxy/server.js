// =============================================================================
// Cláudio Proxy - ponte entre PavCon (Edge Function) e Claude Code CLI
// =============================================================================
// Roda na máquina do orçamentista (que tem Claude Code Max subscription).
// Expõe um endpoint HTTP que o Edge Function chama via Cloudflare Tunnel.
//
// O proxy executa `claude -p <prompt>` via subprocess e devolve a resposta.
// A subscription Max é usada automaticamente porque o `claude` CLI guarda
// as credenciais OAuth quando o usuário faz login.
//
// Uso:
//   1. Instalar: npm install
//   2. Logar no Claude Code (se ainda não): claude login
//   3. Rodar: npm start (porta 3001 por default, configurável via PORT env)
//   4. Expor publicamente via Cloudflare Tunnel (vide README)
// =============================================================================

import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { setTimeout as delay } from 'timers/promises';

const PORT = process.env.PORT || 3001;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 300000); // 5 min (operações no repo levam mais tempo)
const AUTH_TOKEN = process.env.CLAUDIO_PROXY_TOKEN || '';

// Diretório do repositório — o Claude Code roda aqui e tem acesso às ferramentas de arquivo
// Por padrão, sobe um nível a partir do claudio-proxy/
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_PATH = process.env.REPO_PATH || resolve(__dirname, '..');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// =============================================================================
// Middleware: autenticação opcional via Bearer token
// =============================================================================
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!AUTH_TOKEN) return next(); // sem token configurado, libera (modo dev)
  const auth = req.headers.authorization ?? '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Token inválido. Configure Authorization: Bearer <token>.' });
  }
  next();
});

// =============================================================================
// Healthcheck
// =============================================================================
app.get('/health', async (_req, res) => {
  // Verifica se o claude CLI está disponível
  const ok = await new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  res.json({
    ok,
    timestamp: new Date().toISOString(),
    claude_cli: ok ? 'disponível' : 'não encontrado',
    auth_required: !!AUTH_TOKEN,
  });
});

// =============================================================================
// POST /chat — Recebe pergunta, executa claude CLI, devolve resposta
// =============================================================================
// Body:
//   {
//     "system": "string (system prompt)",
//     "messages": [{role, content}, ...],
//     "max_loops": 8
//   }
//
// Estratégia: como o CLI não tem tool use estruturado fácil de parsear, a
// gente cola system + histórico num único prompt. Tool calls do Cláudio
// vão ser instruídas no system prompt como XML tags que parseamos no
// Edge Function. O CLI só executa um turn por vez.
// =============================================================================
app.post('/chat', async (req, res) => {
  const { system, messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages obrigatório (array não vazio).' });
  }

  // Monta o prompt completo a partir das mensagens.
  // O Claude Code CLI aceita system via flag e o resto como prompt input.
  const promptCompleto = messages.map((m) => {
    const role = m.role === 'user' ? 'Human' : 'Assistant';
    const content = typeof m.content === 'string'
      ? m.content
      : JSON.stringify(m.content);
    return `${role}: ${content}`;
  }).join('\n\n');

  // Executa: claude -p "<prompt>" [opções]
  // Flags úteis:
  //   -p / --print: modo headless, retorna stdout
  //   --output-format text|json: formato saída
  //   --append-system-prompt: adiciona ao system padrão
  // Pra ver as opções disponíveis: `claude --help`
  // --dangerously-skip-permissions: permite que o Claude edite/leia arquivos sem pedir confirmação
  // Seguro aqui porque o que chega é o prompt do Cláudio (Edge Function autenticada), não input direto do usuário
  const args = [
    '--print',
    '--output-format', 'text',
    '--dangerously-skip-permissions',
  ];
  if (system) {
    args.push('--append-system-prompt', system);
  }

  console.log(`[claudio-proxy] chamando claude com ${messages.length} mensagem(ns) | repo: ${REPO_PATH}`);
  const startedAt = Date.now();

  try {
    const result = await executarClaude(args, promptCompleto);
    const duration = Date.now() - startedAt;
    console.log(`[claudio-proxy] resposta em ${duration}ms (${result.stdout.length} chars)`);
    res.json({
      ok: true,
      resposta: result.stdout.trim(),
      via: 'claude-code-cli',
      duration_ms: duration,
    });
  } catch (e) {
    console.error('[claudio-proxy] erro:', e);
    res.status(500).json({
      error: e instanceof Error ? e.message : String(e),
      duration_ms: Date.now() - startedAt,
    });
  }
});

// =============================================================================
// Helper: executa CLI claude com timeout
// =============================================================================
function executarClaude(args, stdinInput) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      cwd: REPO_PATH, // Claude Code roda dentro do repositório — tem acesso a todos os arquivos
    });

    let stdout = '';
    let stderr = '';
    let finalizado = false;

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      if (finalizado) return;
      finalizado = true;
      reject(new Error(`Falha ao executar ${CLAUDE_BIN}: ${err.message}. Instalado? Logado? Tenta 'claude --version' e 'claude login' no terminal.`));
    });

    proc.on('close', (code) => {
      if (finalizado) return;
      finalizado = true;
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`claude CLI exit ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`));
      }
    });

    // Envia o prompt via stdin
    if (stdinInput) {
      proc.stdin.write(stdinInput);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }

    // Timeout
    (async () => {
      await delay(TIMEOUT_MS);
      if (!finalizado) {
        finalizado = true;
        proc.kill('SIGTERM');
        reject(new Error(`Timeout (${TIMEOUT_MS}ms) — claude CLI travou ou levou demais.`));
      }
    })();
  });
}

// =============================================================================
// Start
// =============================================================================
app.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║                    🤖 Cláudio Proxy                         ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Porta: ${String(PORT).padEnd(50)}║`);
  console.log(`║  CLI:   ${CLAUDE_BIN.padEnd(50)}║`);
  console.log(`║  Auth:  ${(AUTH_TOKEN ? 'token configurado' : 'desativada (modo dev)').padEnd(50)}║`);
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  Healthcheck: http://localhost:' + PORT + '/health                  ║');
  console.log('║  Chat:        POST http://localhost:' + PORT + '/chat              ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Próximo passo: expor publicamente via Cloudflare Tunnel.');
  console.log('Vide README.md pra setup.');
  console.log('');
});
