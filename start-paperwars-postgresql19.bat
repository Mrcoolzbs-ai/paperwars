@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
title Paper Wars - local game client

echo.
echo ======================================================
echo PAPER WARS: REBIRTH - LOCAL START
echo Native PostgreSQL for Windows - no Docker Desktop
echo ======================================================
echo.

if not exist "package.json" (
  echo [ERROR] package.json was not found.
  echo Put this BAT file in the repository root folder.
  goto failed
)

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install Node.js 22 or newer.
  start "" "https://nodejs.org/"
  goto failed
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js 22 or newer is required.
  node --version
  goto failed
)

where corepack >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Corepack was not found. Reinstall Node.js 22+ with Corepack enabled.
  goto failed
)

if not exist ".env" (
  if not exist ".env.example" (
    echo [ERROR] .env.example was not found.
    goto failed
  )
  copy /Y ".env.example" ".env" >nul
  if errorlevel 1 goto failed
  echo [OK] Created .env from .env.example.
) else (
  echo [OK] Existing .env found; it will not be overwritten.
)

echo.
echo [1/4] Installing workspace dependencies...
call corepack pnpm install --no-frozen-lockfile
if errorlevel 1 (
  echo [ERROR] Dependency installation failed.
  goto failed
)

echo.
echo [2/4] Applying PostgreSQL migrations...
call corepack pnpm --filter @paper-wars/persistence db:migrate
if errorlevel 1 (
  echo [ERROR] Database migrations failed.
  echo Check DATABASE_URL in .env and confirm PostgreSQL is running.
  goto failed
)

echo.
echo [3/4] Building workspace packages...
call corepack pnpm -r --workspace-concurrency=1 --if-present build
if errorlevel 1 (
  echo [ERROR] Project build failed.
  goto failed
)

echo.
echo [4/4] Checking the local API...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/health' -TimeoutSec 2; if ($r.StatusCode -ne 200) { exit 1 }; $health = $r.Content | ConvertFrom-Json; if ($health.apiContractVersion -eq 'browser-auth-v1') { exit 0 }; exit 2 } catch { exit 1 }" >nul 2>&1
if errorlevel 2 goto stale_api
if not errorlevel 1 goto already_running

echo Starting the Paper Wars API in a separate window...
start "Paper Wars API" /D "%~dp0" cmd /k "call corepack pnpm --filter @paper-wars/api dev"

echo Waiting for the API and browser client...
for /L %%I in (1,1,30) do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $h = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/health' -TimeoutSec 2; $health = $h.Content | ConvertFrom-Json; $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/' -TimeoutSec 2; if ($health.apiContractVersion -eq 'browser-auth-v1' -and $r.StatusCode -eq 200 -and $r.Content -match 'auth-screen') { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
  if not errorlevel 1 goto client_ready
  timeout /t 2 /nobreak >nul
)

echo [ERROR] The browser client did not become ready within 60 seconds.
echo Check the separate "Paper Wars API" window for the startup error.
goto failed

:stale_api
echo [ERROR] An older Paper Wars API is already using port 3000.
echo This old process can make the updated browser client fail during login or registration.
echo Close the old "Paper Wars API" window, then run this launcher again.
goto failed

:already_running
echo [OK] An API is already responding on port 3000.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/' -TimeoutSec 3; if ($r.StatusCode -eq 200 -and $r.Content -match 'auth-screen') { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  echo [ERROR] The server on port 3000 is an older API without the browser client.
  echo Close the old "Paper Wars API" window, update the project files, and run this file again.
  goto failed
)

:client_ready
echo [OK] Paper Wars browser client is ready.
echo.
echo Opening the game: http://127.0.0.1:3000
start "" "http://127.0.0.1:3000"
echo.
echo The "Paper Wars API" window must remain open while you play.
echo Press any key to close this launcher window.
pause >nul
exit /b 0

:failed
echo.
echo Startup stopped. Fix the reported problem and run this file again.
echo.
pause
exit /b 1
