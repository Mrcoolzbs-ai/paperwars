@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title Paper Wars - запуск игры

echo.
echo  ======================================================
echo       PAPER WARS: REBIRTH - QUICK START
echo  ======================================================
echo.

if not exist "package.json" (
  echo [ERROR] Не найден package.json. Положите этот BAT-файл в корень репозитория Paper Wars.
  goto failed
)

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js не найден. Установите Node.js 22 или новее и перезапустите файл.
  echo         https://nodejs.org/
  goto failed
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Нужен Node.js версии 22 или новее.
  node --version
  goto failed
)

where corepack >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Corepack не найден. Переустановите Node.js 22+ с Corepack или включите его.
  goto failed
)

where docker >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Docker не найден. Установите Docker Desktop для Windows.
  echo         https://www.docker.com/products/docker-desktop/
  goto failed
)

where powershell >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Windows PowerShell не найден. Он нужен для проверки готовности сервера.
  goto failed
)

if not exist ".env" (
  if not exist ".env.example" (
    echo [ERROR] Не найден .env.example.
    goto failed
  )
  copy /Y ".env.example" ".env" >nul
  if errorlevel 1 (
    echo [ERROR] Не удалось создать .env из шаблона.
    goto failed
  )
  echo [OK] Создан .env с локальными настройками по умолчанию.
) else (
  echo [OK] Найден существующий .env - он не изменяется.
)

set "PORT=3000"
for /f "usebackq tokens=1,* delims==" %%A in (".env") do if "%%A"=="PORT" set "PORT=%%B"
if not defined PORT set "PORT=3000"

echo.
echo [1/5] Проверка Docker Desktop...
docker info >nul 2>&1
if errorlevel 1 (
  echo [WAIT] Запускаю Docker Desktop, если он установлен...
  if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
  if exist "%LOCALAPPDATA%\Programs\Docker\Docker\Docker Desktop.exe" start "" "%LOCALAPPDATA%\Programs\Docker\Docker\Docker Desktop.exe"
  echo [WAIT] Ожидание готовности Docker (до 60 секунд)...
  set "DOCKER_TRIES=0"
  goto wait_docker
)
goto docker_ready

:wait_docker
timeout /t 3 /nobreak >nul
docker info >nul 2>&1
if not errorlevel 1 goto docker_ready
set /a DOCKER_TRIES+=1
if %DOCKER_TRIES% GEQ 20 (
  echo [ERROR] Docker Desktop так и не запустился. Откройте Docker Desktop и повторите запуск.
  goto failed
)
goto wait_docker

:docker_ready
echo [OK] Docker работает.

echo.
echo [2/5] Установка зависимостей pnpm...
call corepack pnpm install --no-frozen-lockfile
if errorlevel 1 (
  echo [ERROR] Не удалось установить зависимости.
  goto failed
)

echo.
echo [3/5] Запуск PostgreSQL 18...
call docker compose up -d db
if errorlevel 1 (
  echo [ERROR] Не удалось запустить PostgreSQL через Docker Compose.
  goto failed
)
set "DB_TRIES=0"
:wait_database
call docker compose exec -T db sh -c "pg_isready -U $POSTGRES_USER -d $POSTGRES_DB" >nul 2>&1
if not errorlevel 1 goto database_ready
set /a DB_TRIES+=1
if %DB_TRIES% GEQ 40 (
  echo [ERROR] PostgreSQL не стал готов за 80 секунд.
  echo         Проверьте контейнер командой: docker compose logs db
  goto failed
)
timeout /t 2 /nobreak >nul
goto wait_database

:database_ready
echo [OK] PostgreSQL готов.

echo.
echo [4/5] Применение миграций базы данных...
call corepack pnpm db:migrate
if errorlevel 1 (
  echo [ERROR] Не удалось применить миграции базы данных.
  goto failed
)

echo.
echo [5/5] Запуск Paper Wars и ожидание API...
call :check_api
if not errorlevel 1 goto open_browser

start "Paper Wars API" /D "%CD%" cmd /k "corepack pnpm start:api"
set "API_TRIES=0"
:wait_api
call :check_api
if not errorlevel 1 goto open_browser
set /a API_TRIES+=1
if %API_TRIES% GEQ 45 (
  echo [ERROR] API не ответил за 90 секунд.
  echo         Посмотрите сообщение об ошибке в открывшемся окне "Paper Wars API".
  goto failed
)
timeout /t 2 /nobreak >nul
goto wait_api

:check_api
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%PORT%/health' -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch { exit 1 }; exit 1" >nul 2>&1
exit /b %errorlevel%

:open_browser
echo [OK] Paper Wars отвечает на http://127.0.0.1:%PORT%.
start "" "http://127.0.0.1:%PORT%"
echo.
echo Игра открыта в браузере. Окно сервера оставьте запущенным.
echo Чтобы остановить сервер, закройте окно "Paper Wars API".
echo PostgreSQL можно остановить командой: docker compose stop db
echo.
exit /b 0

:failed
echo.
echo Запуск остановлен. Исправьте указанную проблему и запустите BAT-файл снова.
echo.
pause
exit /b 1
