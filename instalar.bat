@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (
    echo Node.js nao encontrado. Instale em https://nodejs.org e rode de novo.
    goto :erro
)

if not exist node_modules (
    echo Instalando dependencias...
    call npx --yes pnpm install --frozen-lockfile || goto :erro
)

if not exist .git (
    set EQUICORD_HASH=local
    set EQUICORD_REMOTE=Equicord/Equicord
    set BUILD_FLAGS=--disable-updater
)

echo Compilando o Equicord...
node scripts/build/build.mjs %BUILD_FLAGS% || goto :erro

echo Instalando no Discord...
node scripts/runInstaller.mjs -- --install || goto :erro

echo.
echo Pronto! Reinicie o Discord e ative o P2PScreenShare nas configuracoes do Equicord.
pause
exit /b 0

:erro
echo.
echo Algo deu errado, veja a mensagem acima.
pause
exit /b 1
