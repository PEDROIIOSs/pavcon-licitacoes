// Gerencia o cloudflared tunnel e atualiza o Supabase automaticamente quando a URL mudar
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(__dirname, '.env');

function lerEnv() {
  if (!existsSync(ENV_FILE)) return {};
  return Object.fromEntries(
    readFileSync(ENV_FILE, 'utf8')
      .split('\n')
      .filter(l => l.includes('=') && !l.startsWith('#'))
      .map(l => {
        const idx = l.indexOf('=');
        return [l.slice(0, idx).trim(), l.slice(idx + 1).trim().replace(/^["']|["']$/g, '')];
      })
  );
}

function atualizarEnv(chave, valor) {
  let conteudo = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
  const regex = new RegExp(`^${chave}=.*$`, 'm');
  const linha = `${chave}=${valor}`;
  if (regex.test(conteudo)) {
    conteudo = conteudo.replace(regex, linha);
  } else {
    conteudo += `\n${linha}`;
  }
  writeFileSync(ENV_FILE, conteudo.trim() + '\n');
}

async function atualizarSupabase(url, token, projectRef) {
  if (!projectRef) return;
  console.log(`[tunnel] atualizando Supabase com nova URL: ${url}`);
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/secrets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify([
        { name: 'CLAUDIO_PROXY_URL', value: url },
      ]),
    });
    if (res.ok) {
      console.log('[tunnel] Supabase atualizado com sucesso!');
    } else {
      const txt = await res.text();
      console.error('[tunnel] erro ao atualizar Supabase:', txt);
    }
  } catch (e) {
    console.error('[tunnel] falha na chamada ao Supabase:', e.message);
  }
}

function iniciarTunnel() {
  const env = lerEnv();
  const PORT = process.env.PORT || env.PORT || 3001;
  const SUPABASE_ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || env.SUPABASE_ACCESS_TOKEN || '';
  const SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF || env.SUPABASE_PROJECT_REF || 'cwgjjjlyccgivscngzgz';

  console.log(`[tunnel] iniciando cloudflared → http://localhost:${PORT}`);

  const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let urlDetectada = false;

  const processarLinha = async (linha) => {
    console.log(`[cloudflared] ${linha}`);
    if (urlDetectada) return;

    const match = linha.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) {
      const url = match[0];
      urlDetectada = true;
      console.log(`\n✅ URL pública do Cláudio: ${url}\n`);

      // Salva no .env para referência
      atualizarEnv('CLAUDIO_PROXY_URL', url);

      // Atualiza o Supabase automaticamente se tiver o token configurado
      if (SUPABASE_ACCESS_TOKEN) {
        await atualizarSupabase(url, SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF);
      } else {
        console.log('[tunnel] SUPABASE_ACCESS_TOKEN não configurado — atualize manualmente:');
        console.log(`  supabase secrets set CLAUDIO_PROXY_URL=${url} --project-ref ${SUPABASE_PROJECT_REF}`);
      }
    }
  };

  proc.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(processarLinha));
  proc.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(processarLinha));

  proc.on('error', (err) => {
    console.error('[tunnel] erro:', err.message);
    console.error('cloudflared instalado? Veja: https://github.com/cloudflare/cloudflared/releases');
    process.exit(1);
  });

  proc.on('close', (code) => {
    console.log(`[tunnel] cloudflared encerrou (código ${code}) — reiniciando...`);
    // PM2 reinicia automaticamente
    process.exit(code ?? 1);
  });
}

iniciarTunnel();
