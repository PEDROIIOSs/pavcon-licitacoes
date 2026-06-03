@echo off
chcp 65001 >nul
title Cláudio - Iniciando...

:: Verifica se PM2 já está configurado
pm2 describe claudio-proxy >nul 2>&1
if %errorlevel% == 0 (
    echo.
    echo ✅ Cláudio já está configurado! Verificando status...
    pm2 restart claudio-proxy claudio-tunnel >nul 2>&1
    pm2 status
    echo.
    echo Cláudio está rodando! Pode usar o PavCon normalmente.
    echo.
    pause
    exit /b 0
)

:: Primeira vez — precisa de admin para instalar PM2 como serviço
echo.
echo 🔧 Primeira execução detectada. Iniciando setup completo...
echo.

:: Pede elevação de admin se necessário
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Precisamos de permissão de Administrador para instalar o serviço.
    echo Uma janela de confirmação vai aparecer — clique em SIM.
    echo.
    PowerShell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

:: Roda o setup
cd /d "%~dp0claudio-proxy"
PowerShell -ExecutionPolicy Bypass -File setup.ps1
pause
