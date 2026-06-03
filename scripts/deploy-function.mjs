// =============================================================================
// scripts/deploy-function.mjs
// Deploy de uma Edge Function via Supabase Management API (sem precisar do
// supabase CLI). Bundla index.ts + _shared/* relevantes (transitivos) num
// multipart upload.
//
// O bundler do servidor coloca os arquivos enviados dentro de um diretório
// `source/`, então qualquer import `../_shared/X.ts` (que vinha do layout
// supabase/functions/<slug>/) NÃO resolve. A solução: reescrever os imports
// pra `./_shared/X.ts` e enviar os shared files com filename `_shared/X.ts`
// (relativo à raiz da função). Tudo fica dentro de `source/` no servidor.
//
// Uso:
//   SUPABASE_PAT=sbp_xxx node scripts/deploy-function.mjs <slug>
//
// Pré-req: Node 18+ (FormData + fetch nativos)
// =============================================================================
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FN_DIR = resolve(__dirname, '..', 'supabase', 'functions');

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'cwgjjjlyccgivscngzgz';
const PAT = process.env.SUPABASE_PAT;
const slug = process.argv[2];

if (!PAT) { console.error('SUPABASE_PAT obrigatório.'); process.exit(1); }
if (!slug) { console.error('Uso: node scripts/deploy-function.mjs <slug>'); process.exit(1); }

const slugDir = join(FN_DIR, slug);
const indexPath = join(slugDir, 'index.ts');
if (!existsSync(indexPath)) {
  console.error(`index.ts não encontrado em ${slugDir}`);
  process.exit(1);
}

// =============================================================================
// Coleta recursiva de imports de _shared/ (entry + transitivos)
// =============================================================================
const sharedCache = new Map(); // relPath ('_shared/X.ts') -> { rewritten }
// Match dois padrões dentro de qualquer arquivo:
//   from '../_shared/X.ts'  ou  from '_shared/X.ts'  (de entry point)
//   from './X.ts'                                      (entre arquivos shared)
const SHARED_FROM_OUTSIDE_RE = /from\s+['"](?:\.\.?\/)*_shared\/([^'"]+)['"]/g;
const SHARED_SIBLING_RE = /from\s+['"]\.\/([^'"\/][^'"]*)['"]/g;

function collect(filePath, srcText) {
  // Caso A: entry/outros importam `_shared/X.ts` (com qualquer prefixo ../).
  const refsOutside = [...srcText.matchAll(SHARED_FROM_OUTSIDE_RE)]
    .map((m) => `_shared/${m[1]}`);
  // Caso B: já estamos DENTRO de _shared — imports `./Y.ts` são siblings
  // que também precisam ser bundlados.
  const inShared = filePath.includes('_shared');
  const refsSibling = inShared
    ? [...srcText.matchAll(SHARED_SIBLING_RE)].map((m) => `_shared/${m[1]}`)
    : [];
  const allRefs = [...new Set([...refsOutside, ...refsSibling])];
  for (const rel of allRefs) {
    if (sharedCache.has(rel)) continue;
    const p = join(FN_DIR, rel);
    if (!existsSync(p)) {
      console.error(`[deploy] shared não encontrado: ${p}`);
      process.exit(1);
    }
    const sharedSrc = readFileSync(p, 'utf8');
    // Reescreve imports `../_shared/X.ts` ou `_shared/X.ts` → `./X.ts`
    // (mesmo dir já que tudo cai junto em _shared/). Imports `./Y.ts`
    // entre siblings ficam inalterados.
    const rewritten = sharedSrc.replace(SHARED_FROM_OUTSIDE_RE, (_m, name) => {
      return `from './${name}'`;
    });
    sharedCache.set(rel, { rewritten });
    // Recurse — pega transitive sibling deps DENTRO do shared
    collect(p, sharedSrc);
  }
}

const indexSrc = readFileSync(indexPath, 'utf8');
collect(indexPath, indexSrc);

// Sibling local files no MESMO dir da função (ex: prompt.ts, schema.ts).
// Pra essas, mantém path relativo `./X.ts` e anexa no upload.
const localSiblings = new Map(); // 'X.ts' -> { src }
const LOCAL_SIBLING_RE = /from\s+['"]\.\/([^'"\/][^'"]*)['"]/g;
const indexSiblings = [...indexSrc.matchAll(LOCAL_SIBLING_RE)].map((m) => m[1]);
for (const sib of indexSiblings) {
  const p = join(slugDir, sib);
  if (existsSync(p)) {
    localSiblings.set(sib, { src: readFileSync(p, 'utf8') });
  }
}

// Reescreve imports do entry: `../_shared/X.ts` → `./_shared/X.ts`
const indexRewritten = indexSrc.replace(SHARED_FROM_OUTSIDE_RE, (_m, name) => {
  return `from './_shared/${name}'`;
});

console.log(`[deploy] slug=${slug}`);
console.log(`[deploy] index.ts (${indexRewritten.length} bytes)`);
console.log(`[deploy] _shared deps (${sharedCache.size}): ${[...sharedCache.keys()].join(', ')}`);
if (localSiblings.size > 0) {
  console.log(`[deploy] local siblings (${localSiblings.size}): ${[...localSiblings.keys()].join(', ')}`);
}

// =============================================================================
// Monta FormData multipart
// =============================================================================
const form = new FormData();
const metadata = {
  name: slug,
  verify_jwt: true,
  entrypoint_path: 'index.ts',
};
form.append('metadata', JSON.stringify(metadata));

form.append('file', new Blob([indexRewritten], { type: 'application/typescript' }), 'index.ts');
for (const [rel, { rewritten }] of sharedCache.entries()) {
  form.append('file', new Blob([rewritten], { type: 'application/typescript' }), rel);
}
for (const [sib, { src }] of localSiblings.entries()) {
  form.append('file', new Blob([src], { type: 'application/typescript' }), sib);
}

const url = `https://api.supabase.com/v1/projects/${PROJECT_REF}/functions/deploy?slug=${slug}`;
console.log(`[deploy] POST ${url}`);

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${PAT}` },
  body: form,
});

const body = await res.text();
if (!res.ok) {
  console.error(`[deploy] HTTP ${res.status}: ${body.slice(0, 800)}`);
  process.exit(1);
}
console.log(`[deploy] OK: ${body.slice(0, 300)}`);
