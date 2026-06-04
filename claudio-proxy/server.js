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
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const PORT = process.env.PORT || 3001;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 120000); // 2 min /chat
const EXTRACT_TIMEOUT_MS = Number(process.env.CLAUDE_EXTRACT_TIMEOUT_MS || 600000); // 10 min /extract
const AUTH_TOKEN = process.env.CLAUDIO_PROXY_TOKEN || '';

const app = express();
app.use(cors());
// Limite alto pra aceitar PDFs grandes (até 50MB de base64).
app.use(express.json({ limit: '60mb' }));

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
  const args = ['--print', '--output-format', 'text'];
  if (system) {
    args.push('--append-system-prompt', system);
  }

  console.log(`[claudio-proxy] chamando claude com ${messages.length} mensagem(ns)`);
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
// POST /extract — Extrai dados estruturados de PDFs via Claude Code
// =============================================================================
// Body:
//   {
//     "system": "system prompt (mesmo do extracao-edital)",
//     "user_intro": "texto introdutório opcional",
//     "pdfs": [{ filename: "ANEXO.pdf", b64: "JVBERi0xL..." }, ...],
//     "trailing_instruction": "Responda APENAS com JSON..."
//   }
//
// Estratégia: escreve os PDFs num diretório temporário, monta um prompt
// que referencia os arquivos por path, invoca `claude -p` com cwd
// apontando pra esse diretório. O Claude Code usa a tool Read pra ler
// cada PDF (suporta PDFs nativamente desde out/2024) e produz a resposta.
//
// Não usamos --output-format json porque queremos o texto bruto da
// resposta (que vai ser JSON do edital). O parser do Edge Function já
// trata fences markdown, jsonrepair, etc.
// =============================================================================
app.post('/extract', async (req, res) => {
  const { system, user_intro, pdfs, trailing_instruction } = req.body || {};
  if (!Array.isArray(pdfs) || pdfs.length === 0) {
    return res.status(400).json({ error: 'pdfs obrigatório (array não vazio com {filename, b64}).' });
  }

  const startedAt = Date.now();
  const tmp = await mkdtemp(join(tmpdir(), 'claudio-extract-'));
  console.log(`[claudio-proxy] /extract: ${pdfs.length} PDF(s) em ${tmp}`);

  try {
    // 1) Escreve cada PDF em arquivo temporário
    const writtenFiles = [];
    for (let i = 0; i < pdfs.length; i++) {
      const safeFilename = (pdfs[i].filename ?? `arquivo_${i + 1}.pdf`)
        .replace(/[^\w.-]/g, '_')
        .slice(0, 80);
      const fpath = join(tmp, safeFilename);
      const buf = Buffer.from(pdfs[i].b64, 'base64');
      await writeFile(fpath, buf);
      writtenFiles.push(safeFilename);
    }

    // 2) Monta prompt: pede pro Claude ler cada arquivo e responder com JSON.
    // Mantém system separado via --append-system-prompt.
    const partes = [];
    if (user_intro) partes.push(user_intro);
    partes.push(
      `Os seguintes PDFs estão disponíveis no diretório atual. ` +
      `Use a tool Read pra ler CADA UM antes de produzir o JSON:`,
    );
    partes.push(writtenFiles.map((f, i) => `  ${i + 1}. ${f}`).join('\n'));
    if (trailing_instruction) partes.push(trailing_instruction);
    const promptCompleto = partes.join('\n\n');

    // 3) Invoca o CLI com cwd no diretório dos PDFs
    const args = ['--print', '--output-format', 'text'];
    if (system) args.push('--append-system-prompt', system);

    const result = await executarClaude(args, promptCompleto, {
      cwd: tmp,
      timeoutMs: EXTRACT_TIMEOUT_MS,
    });
    const duration = Date.now() - startedAt;
    console.log(`[claudio-proxy] /extract resposta em ${(duration / 1000).toFixed(1)}s (${result.stdout.length} chars)`);
    res.json({
      ok: true,
      text: result.stdout.trim(),
      via: 'claude-code-cli',
      duration_ms: duration,
      pdfs_lidos: writtenFiles.length,
    });
  } catch (e) {
    console.error('[claudio-proxy] /extract erro:', e);
    res.status(500).json({
      error: e instanceof Error ? e.message : String(e),
      duration_ms: Date.now() - startedAt,
    });
  } finally {
    // 4) Limpa temp dir (best-effort)
    try { await rm(tmp, { recursive: true, force: true }); } catch {}
  }
});

// =============================================================================
// Helper: executa CLI claude com timeout
// =============================================================================
function executarClaude(args, stdinInput, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      cwd: opts.cwd, // undefined → diretório atual (default)
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

    // Timeout (configurável: /chat usa TIMEOUT_MS, /extract usa EXTRACT_TIMEOUT_MS)
    (async () => {
      await delay(timeoutMs);
      if (!finalizado) {
        finalizado = true;
        proc.kill('SIGTERM');
        reject(new Error(`Timeout (${timeoutMs}ms) — claude CLI travou ou levou demais.`));
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
  console.log('║  Extract:     POST http://localhost:' + PORT + '/extract           ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Próximo passo: expor publicamente via Cloudflare Tunnel.');
  console.log('Vide README.md pra setup.');
  console.log('');
});
