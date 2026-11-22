# Paper Wars: Rebirth

Браузерная пошаговая военно-политическая стратегия. Нормативная спецификация проекта находится в [Documentation Baseline v1.0](docs/README.md).

## Текущий статус

- **Documentation Baseline v1.0** зафиксирован в `main`.
- **Stage 1.1** — monorepo bootstrap, API health-check и базовый CI: merged (PR #3).
- **Stage 1.2** — PostgreSQL 18, Drizzle schema, миграции и integration tests: merged (PR #4).
- **Stage 1.3** — deterministic RNG, commit-reveal seed service, AES-256-GCM, versioned keys и random draw audit log: merged (PR #5).
- **Stage 1.4** — scrypt auth, HS256 access JWT, rotating refresh sessions/replay detection и атомарное campaign + first seed create: merged (PR #6).
- **Stage 1.5** — branded domain entities, snapshot/order/event/turn contracts, ruleset compatibility и schema-version migrations: merged (PR #7).
- PR #8 (Draft): предварительная регистрация и согласование религий/идеологий до создания государства, стартовая территория 5×5 и семь зданий; CI прошёл: build, typecheck, lint, format-check и 60/60 тестов на PostgreSQL 18.7.
- PR #8 также добавляет первый графический Web-клиент: карта, выбор территории, редактор стартовой раскладки и подключение к API.

Спецификация и код не означают, что игра уже реализует полный ход. Q18–Q20 остаются сюжетными PROPOSAL и не входят в канон.

## Структура

- `apps/api` — HTTP API.
- `packages/shared` — общие типы и утилиты.
- `packages/domain` — доменные контракты.
- `packages/simulation` — оболочка детерминированного Simulation Engine.
- `packages/persistence` — PostgreSQL/Drizzle persistence и миграции.
- `tests` — smoke и интеграционные тесты.
- `docs` — Documentation Baseline v1.0 и roadmap.

## Требования

- Node.js 22 или совместимый поддерживаемый LTS-релиз.
- pnpm 9.15.x.
- Docker Compose для локальной PostgreSQL.

## Установка и запуск PostgreSQL

```bash
corepack pnpm install
cp .env.example .env
docker compose up -d db
corepack pnpm db:migrate
```

Для тестов с локальной БД:

```bash
DATABASE_URL=postgresql://paperwars:change-me-local-only@127.0.0.1:5432/paperwars corepack pnpm test
```

## Проверки

```bash
corepack pnpm format:check
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
```

GitHub Actions поднимает отдельный PostgreSQL service и выполняет миграционные integration tests автоматически.

## Запуск игры и графического клиента

**Windows:** установите Node.js 22+ и дважды нажмите `start-paperwars.bat` в корне репозитория. Если Docker Desktop отсутствует, скрипт предложит установить его через `winget` (либо откроет официальную страницу установки); если Docker установлен, но не запущен, скрипт попробует его открыть. Далее он создаст `.env` (если его ещё нет), установит зависимости, поднимет PostgreSQL, применит миграции, соберёт проект, запустит API в отдельном окне и откроет браузер. Существующий `.env` скрипт не перезаписывает. Для работы Docker Desktop может потребоваться WSL 2, включённая аппаратная виртуализация и перезагрузка Windows.

**Linux/macOS:** соберите проект и запустите API вместе с Web-клиентом:

```bash
corepack pnpm build
corepack pnpm dev:api
```

Откройте **http://127.0.0.1:3000**. Клиент использует тот же origin, поэтому авторизация работает через существующие access/refresh-сессии без отдельной настройки CORS. Для production-подобного запуска используйте `corepack pnpm start:api`.

Первый графический экран включает карту с выбором центра стартовой территории, редактор 5×5 и размещение семи стартовых зданий, регистрацию/вход, создание кампаний, отправку религий и идеологий на согласование и панель проверки для администраторов. Гостевой режим показывает демонстрационную карту, не сохраняющую состояние.

Разделы приказов, армии, дипломатии и полный движок ходов пока не реализованы. Кнопки этих разделов показывают, что механики находятся в разработке.

Health-check API: `GET http://127.0.0.1:3000/health`.

## Текущие ограничения

- Participant invitations/roles, audit trail и rate limiting для публичных auth endpoints пока не реализованы.
- Базовый начальный country setup вынесен в Draft PR #8: выбор одобренной системы, территория 5×5, стартовые здания/население и первичный snapshot. Полноценное состояние мира и дальнейшие игровые механики ещё впереди.
- Domain contracts и pure TurnResolver interface уже есть, но Simulation Engine пока не исполняет игровые ходы.
- PostgreSQL Worker, закрытие приказов, lease/fencing и atomic turn finalization ещё не реализованы.
- Графический Web-клиент предварительной версии добавлен; публичный API seed reveal, полный Simulation Engine и игровой цикл ещё не реализованы.
- Stage 1 DoD не достигнут: полного end-to-end цикла «приказ → worker → симуляция → snapshot → API» пока нет.

## Seed encryption configuration

Copy `.env.example` to `.env` for local development. The included `dev-v1` key is a public placeholder and must never be used for deployed or production campaigns. Production keys must be supplied through a protected environment, Docker secrets, Vault or KMS; never commit real key material. Keep every historical key version available until all campaigns encrypted with it have completed and their seeds have been revealed.
