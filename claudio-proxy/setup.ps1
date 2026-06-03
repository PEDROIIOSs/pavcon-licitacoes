# =============================================================================
# Setup completo do Cláudio Proxy — Windows PowerShell
# Execute UMA VEZ como Administrador, depois esqueça. Tudo roda automaticamente.
# =============================================================================
# Como usar:
#   1. Abra o PowerShell como Administrador
#   2. Navegue até a pasta: cd caminho\para\pavcon-licitacoes\claudio-proxy
#   3. Execute: .\setup.ps1
# =============================================================================

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║           🤖 Setup Automático do Cláudio Proxy              ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── 1. Verifica pré-requisitos ────────────────────────────────────────────────
Write-Host "▶ Verificando pré-requisitos..." -ForegroundColor Yellow

# Node.js
try { $nodeVer = node --version } catch { Write-Error "Node.js não encontrado. Instale em https://nodejs.org"; exit 1 }
Write-Host "  ✓ Node.js $nodeVer"

# Claude Code CLI
try { $claudeVer = claude --version 2>&1 } catch { Write-Error "Claude Code não encontrado. Instale em https://claude.ai/download"; exit 1 }
Write-Host "  ✓ Claude Code: $claudeVer"

# cloudflared
$cloudflaredOk = $false
try { cloudflared --version | Out-Null; $cloudflaredOk = $true } catch {}
if (-not $cloudflaredOk) {
    Write-Host "  ⚠ cloudflared não encontrado. Instalando via winget..." -ForegroundColor Yellow
    winget install --id Cloudflare.cloudflared --silent
    Write-Host "  ✓ cloudflared instalado"
} else {
    Write-Host "  ✓ cloudflared"
}

# PM2
$pm2Ok = $false
try { pm2 --version | Out-Null; $pm2Ok = $true } catch {}
if (-not $pm2Ok) {
    Write-Host "  ⚠ PM2 não encontrado. Instalando..." -ForegroundColor Yellow
    npm install -g pm2
    npm install -g pm2-windows-startup
    Write-Host "  ✓ PM2 instalado"
} else {
    Write-Host "  ✓ PM2"
}

# ── 2. Instala dependências do proxy ──────────────────────────────────────────
Write-Host ""
Write-Host "▶ Instalando dependências do proxy..." -ForegroundColor Yellow
npm install
Write-Host "  ✓ Dependências instaladas"

# ── 3. Cria pasta de logs ─────────────────────────────────────────────────────
if (-not (Test-Path "logs")) { New-Item -ItemType Directory -Path "logs" | Out-Null }

# ── 4. Gera ou reutiliza .env ─────────────────────────────────────────────────
Write-Host ""
Write-Host "▶ Configurando variáveis de ambiente..." -ForegroundColor Yellow

$envFile = ".env"
$envConteudo = @{}
if (Test-Path $envFile) {
    Get-Content $envFile | Where-Object { $_ -match "=" -and $_ -notmatch "^#" } | ForEach-Object {
        $parts = $_ -split "=", 2
        $envConteudo[$parts[0].Trim()] = $parts[1].Trim().Trim('"').Trim("'")
    }
}

# Token de autenticação
if (-not $envConteudo["CLAUDIO_PROXY_TOKEN"]) {
    $token = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    $envConteudo["CLAUDIO_PROXY_TOKEN"] = $token
    Write-Host "  ✓ Token gerado automaticamente"
} else {
    Write-Host "  ✓ Token já configurado"
}

# Supabase Access Token (para atualizar URL automaticamente)
if (-not $envConteudo["SUPABASE_ACCESS_TOKEN"]) {
    Write-Host ""
    Write-Host "  Para atualizar o Supabase automaticamente quando o tunnel reiniciar," -ForegroundColor Gray
    Write-Host "  informe seu Supabase Access Token (em app.supabase.com → Account → Access Tokens)." -ForegroundColor Gray
    Write-Host "  Deixe em branco para pular (vai precisar atualizar manualmente)." -ForegroundColor Gray
    $supabaseToken = Read-Host "  Supabase Access Token"
    if ($supabaseToken) {
        $envConteudo["SUPABASE_ACCESS_TOKEN"] = $supabaseToken
        Write-Host "  ✓ Token do Supabase salvo"
    }
}

$envConteudo["SUPABASE_PROJECT_REF"] = "cwgjjjlyccgivscngzgz"
$envConteudo["PORT"] = "3001"

# Escreve .env
$linhas = $envConteudo.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }
$linhas | Set-Content $envFile
Write-Host "  ✓ .env salvo"

# ── 5. Inicia com PM2 ─────────────────────────────────────────────────────────
Write-Host ""
Write-Host "▶ Iniciando serviços com PM2..." -ForegroundColor Yellow

# Para processos antigos se existirem
pm2 delete claudio-proxy 2>$null
pm2 delete claudio-tunnel 2>$null

pm2 start ecosystem.config.cjs
pm2 save

Write-Host "  ✓ Proxy e tunnel iniciados"

# ── 6. Configura para iniciar com o Windows ───────────────────────────────────
Write-Host ""
Write-Host "▶ Configurando inicialização automática com o Windows..." -ForegroundColor Yellow
pm2-startup install
pm2 save
Write-Host "  ✓ PM2 configurado para iniciar com o Windows"

# ── 7. Aguarda URL do tunnel ──────────────────────────────────────────────────
Write-Host ""
Write-Host "▶ Aguardando URL do tunnel..." -ForegroundColor Yellow
Write-Host "  (pode levar até 30 segundos)" -ForegroundColor Gray

$url = ""
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $logs = pm2 logs claudio-tunnel --lines 50 --nostream 2>&1 | Out-String
    $match = [regex]::Match($logs, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($match.Success) {
        $url = $match.Value
        break
    }
}

Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║                    ✅ Setup concluído!                      ║" -ForegroundColor Green
Write-Host "╠════════════════════════════════════════════════════════════╣" -ForegroundColor Green
if ($url) {
    Write-Host "║  URL pública: $($url.PadRight(45))║" -ForegroundColor Green
    Write-Host "║  Supabase: atualizado automaticamente                      ║" -ForegroundColor Green
} else {
    Write-Host "║  URL: veja com: pm2 logs claudio-tunnel                    ║" -ForegroundColor Yellow
    Write-Host "║  Supabase: atualize manualmente com a URL acima            ║" -ForegroundColor Yellow
}
Write-Host "╠════════════════════════════════════════════════════════════╣" -ForegroundColor Green
Write-Host "║  Agora é só mandar mensagem pro Cláudio no PavCon!         ║" -ForegroundColor Green
Write-Host "╚════════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "Comandos úteis:" -ForegroundColor Gray
Write-Host "  pm2 status              → ver se está rodando" -ForegroundColor Gray
Write-Host "  pm2 logs claudio-proxy  → ver logs do proxy" -ForegroundColor Gray
Write-Host "  pm2 logs claudio-tunnel → ver URL do tunnel" -ForegroundColor Gray
Write-Host "  pm2 restart all         → reiniciar tudo" -ForegroundColor Gray
