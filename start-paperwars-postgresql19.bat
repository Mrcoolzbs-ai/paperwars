@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
title Paper Wars - local server

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
REM Call the workspace package directly. The root db:migrate script invokes
REM a nested "pnpm" command that may not be on PATH on Windows.
call corepack pnpm --filter @paper-wars/persistence db:migrate
if errorlevel 1 (
  echo [ERROR] Database migrations failed.
  echo Check DATABASE_URL in .env and confirm the PostgreSQL service is running.
  goto failed
)

echo.
echo [3/4] Building workspace packages...
REM Run the recursive pnpm command directly instead of the root build script.
call corepack pnpm -r --workspace-concurrency=1 --if-present build
if errorlevel 1 (
  echo [ERROR] Project build failed.
  goto failed
)

echo.
echo [4/4] Checking the local API...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/health' -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 goto already_running

echo Starting the Paper Wars API in a separate window...
start "Paper Wars API" /D "%~dp0" cmd /k "call corepack pnpm --filter @paper-wars/api dev"

echo Waiting for the API to become ready...
set "PW_READY="
for /L %%I in (1,1,30) do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/health' -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
  if not errorlevel 1 (
    set "PW_READY=1"
    goto server_ready
  )
  timeout /t 2 /nobreak >nul
)

echo [ERROR] The API did not become ready within 60 seconds.
echo Check the separate "Paper Wars API" window for the startup error.
goto failed

:already_running
echo [OK] A Paper Wars API is already responding on port 3000.
goto open_status

:server_ready
echo [OK] Paper Wars API is responding.

:open_status
echo.
echo Opening the API health page: http://127.0.0.1:3000/health
start "" "http://127.0.0.1:3000/health"
echo.
echo The API window must remain open while you use the server.
echo Press any key to close this launcher window.
pause >nul
exit /b 0

:failed
echo.
echo Startup stopped. Fix the reported problem and run this file again.
echo.
pause
exit /b 1
