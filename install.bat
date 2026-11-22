@echo off
setlocal
set "ASAR=%APPDATA%\Equicord\equicord.asar"
set "CLI=%TEMP%\EquilotlCli.exe"

echo Downloading Equicord with P2PScreenShare...
if not exist "%APPDATA%\Equicord" mkdir "%APPDATA%\Equicord"
curl -fL --retry 3 -o "%ASAR%" https://github.com/N1katine/Equicord/releases/latest/download/desktop.asar || goto :error

echo Downloading the Equicord installer...
curl -fL --retry 3 -o "%CLI%" https://github.com/Equicord/Equilotl/releases/latest/download/EquilotlCli.exe || goto :error

echo Closing Discord...
taskkill /f /im Discord.exe /im DiscordPTB.exe /im DiscordCanary.exe >nul 2>nul

echo Installing into Discord...
rem Makes the installer use the asar downloaded above instead of downloading the official Equicord.
set "EQUICORD_DEV_INSTALL=1"
set "EQUICORD_DIRECTORY=%ASAR%"
"%CLI%" --install --branch auto || goto :error

echo.
echo Done! Open Discord and enable P2PScreenShare in the Equicord settings.
echo Future updates arrive through Equicord itself.
pause
exit /b 0

:error
echo.
echo Something went wrong, see the message above.
pause
exit /b 1
