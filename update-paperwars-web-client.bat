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

echo Downloading the seeded world generator, campaign capacity, country setup, browser client and database migrations...
echo Your .env file and existing database data are not deleted or reset. The additive migrations 0006 and 0007 are included; existing campaign data is retained.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $files=@('packages/world/src/types.ts','packages/world/src/index.ts','packages/world/src/map-generation.ts','packages/world/src/country-setup.ts','packages/auth/src/campaigns.ts','packages/persistence/src/postgres/schema.ts','packages/persistence/migrations/0006_campaign_setup_enhancements.sql','packages/persistence/migrations/0007_campaign_world_seed.sql','apps/api/src/app.ts','apps/web/public/index.html','apps/web/public/styles.css','apps/web/public/app.js','apps/web/public/favicon.svg','README.md','docs/roadmap.md','start-paperwars-postgresql19.bat'); foreach($file in $files){$directory=Split-Path -Parent $file; if(-not [string]::IsNullOrWhiteSpace($directory)){New-Item -ItemType Directory -Force -Path $directory | Out-Null}; $url='https://raw.githubusercontent.com/Mrcoolzbs-ai/paperwars/stage-3-browser-client/'+$file; $temporary=$file+'.download'; try {Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $temporary; Move-Item -Force $temporary $file; Write-Host ('[OK] '+$file)} catch {if(Test-Path $temporary){Remove-Item -Force $temporary}; throw}}"
if errorlevel 1 (
  echo.
  echo [ERROR] Download failed. Check your internet connection and try again.
  goto failed
)

echo.
echo [OK] World generation, campaign setup and browser client have been updated.
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
