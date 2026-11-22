@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
title Paper Wars - update browser client

echo.
echo ======================================================
echo PAPER WARS: REBIRTH - CLIENT UPDATE
echo ======================================================
echo.

if not exist "package.json" (
  echo [ERROR] package.json was not found.
  echo Put this file in the root of your Paper Wars folder.
  goto failed
)

where powershell >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Windows PowerShell was not found.
  goto failed
)

echo Downloading the browser client and API route from GitHub...
echo Your .env file and database are not changed.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $files=@('apps/api/src/app.ts','apps/web/public/index.html','apps/web/public/styles.css','apps/web/public/app.js','apps/web/public/favicon.svg','start-paperwars-postgresql19.bat'); foreach($file in $files){$directory=Split-Path -Parent $file; New-Item -ItemType Directory -Force -Path $directory | Out-Null; $url='https://raw.githubusercontent.com/Mrcoolzbs-ai/paperwars/stage-3-browser-client/'+$file; Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file; Write-Host ('[OK] '+$file)}"
if errorlevel 1 (
  echo.
  echo [ERROR] Download failed. Check your internet connection and try again.
  goto failed
)

echo.
echo [OK] Browser client files have been updated.
echo Next: close any old "Paper Wars API" window and run start-paperwars-postgresql19.bat.
echo.
pause
exit /b 0

:failed
echo.
echo Update failed. No database changes were made.
echo.
pause
exit /b 1
