@echo off
setlocal
set "ASAR=%APPDATA%\Equicord\equicord.asar"
set "CLI=%TEMP%\EquilotlCli.exe"

echo Baixando o Equicord com o P2PScreenShare...
if not exist "%APPDATA%\Equicord" mkdir "%APPDATA%\Equicord"
curl -fL --retry 3 -o "%ASAR%" https://github.com/N1katine/Equicord/releases/latest/download/desktop.asar || goto :erro

echo Baixando o instalador do Equicord...
curl -fL --retry 3 -o "%CLI%" https://github.com/Equicord/Equilotl/releases/latest/download/EquilotlCli.exe || goto :erro

echo Fechando o Discord...
taskkill /f /im Discord.exe /im DiscordPTB.exe /im DiscordCanary.exe >nul 2>nul

echo Instalando no Discord...
rem Faz o instalador usar o asar baixado acima em vez de baixar o Equicord oficial.
set "EQUICORD_DEV_INSTALL=1"
set "EQUICORD_DIRECTORY=%ASAR%"
"%CLI%" --install --branch auto || goto :erro

echo.
echo Pronto! Abra o Discord e ative o P2PScreenShare nas configuracoes do Equicord.
echo As proximas atualizacoes chegam pelo proprio Equicord.
pause
exit /b 0

:erro
echo.
echo Algo deu errado, veja a mensagem acima.
pause
exit /b 1
