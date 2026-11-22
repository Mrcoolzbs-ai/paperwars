@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
title Paper Wars - update browser client and specification

echo.
echo ======================================================
echo PAPER WARS: REBIRTH - CLIENT AND SPEC UPDATE
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

echo Downloading the browser client, building images, migrations 0006-0008,
echo and restored specification. Your .env and PostgreSQL data are preserved.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $files=@('packages/world/src/types.ts','packages/world/src/index.ts','packages/world/src/map-generation.ts','packages/world/src/country-setup.ts','packages/auth/src/campaigns.ts','packages/persistence/src/postgres/schema.ts','packages/persistence/migrations/0006_campaign_setup_enhancements.sql','packages/persistence/migrations/0007_campaign_world_seed.sql','packages/persistence/migrations/0008_player_social_system_library.sql','apps/api/src/app.ts','apps/web/public/index.html','apps/web/public/styles.css','apps/web/public/app.js','apps/web/public/favicon.svg','apps/web/public/assets/buildings/barracks.jpg','apps/web/public/assets/buildings/capital.jpg','apps/web/public/assets/buildings/factory.jpg','apps/web/public/assets/buildings/field.jpg','apps/web/public/assets/buildings/gold-mark.jpg','apps/web/public/assets/buildings/science.jpg','apps/web/public/assets/buildings/tower.jpg','README.md','docs/README.md','docs/RECOVERED_SPECIFICATION.md','docs/SPECIFICATION.md','docs/architecture/social-systems.md','docs/architecture/web-client.md','docs/roadmap.md','start-paperwars-postgresql19.bat'); foreach($file in $files){$directory=Split-Path -Parent $file;if(-not [string]::IsNullOrWhiteSpace($directory)){New-Item -ItemType Directory -Force -Path $directory | Out-Null};$url='https://raw.githubusercontent.com/Mrcoolzbs-ai/paperwars/stage-3-browser-client/'+$file;$temporary=$file+'.download';try{Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $temporary;Move-Item -Force $temporary $file;Write-Host ('[OK] '+$file)}catch{if(Test-Path $temporary){Remove-Item -Force $temporary};throw}}"
if errorlevel 1 (
  echo.
  echo [ERROR] Download failed. No database changes were made.
  goto failed
)
echo.
echo [OK] Client and project specification have been updated.
echo Migration files 0006-0008 are installed but not applied by this updater.
echo Next: close the old API window and run start-paperwars-postgresql19.bat.
echo.
pause
exit /b 0

:failed
echo.
echo Update failed. Fix the reported problem and run this file again.
echo.
pause
exit /b 1
