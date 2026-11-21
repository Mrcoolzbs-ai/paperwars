# Paper Wars: Rebirth

Браузерная пошаговая военно-политическая стратегия. Нормативная спецификация проекта находится в [Documentation Baseline v1.0](docs/README.md).

## Текущий статус

- **Documentation Baseline v1.0** зафиксирован в `main`.
- **Stage 1.1** — monorepo bootstrap, API health-check и базовый CI: merged (PR #3).
- **Stage 1.2** — PostgreSQL 18, Drizzle schema, миграции и integration tests: merged (PR #4).
- **Stage 1.3** — deterministic RNG, commit-reveal seed service, AES-256-GCM, versioned keys и random draw audit log: merged (PR #5).
- **Stage 1.4** — scrypt auth, HS256 access JWT, rotating refresh sessions/replay detection и атомарное campaign + first seed create: merged (PR #6).
- **Stage 1.5** — branded domain entities, snapshot/order/event/turn contracts, ruleset compatibility и schema-version migrations: merged (PR #7).
- **Stage 1.7** — deterministic phase runner, 14 фаз и RNG audit: PR #9, CI 63/63 теста, ожидает merge. Это orchestration layer, не готовые игровые механики.
- **Stage 1.8** — closeOrders, PostgreSQL jobs, leases, reaper и atomic finalize: PR #10, CI 69/69 тестов, ожидает merge после PR #9.
- **Worker runtime** — PostgreSQL worker process, verified input loader, deterministic RNG, heartbeat и atomic finalize: PR #11, CI 73/73 теста.
- **Stage 1.9 — Campaign/Orders API** — PR #12, stacked поверх Worker Runtime; membership view/leave, собственные приказы CRUD/confirm, turn status/close и fail-closed world DTO-projection. CI: **75/75 тестов**.

Спецификация и код не означают, что игра уже реализует полный ход. Q18–Q20 остаются сюжетными PROPOSAL и не входят в канон.

## Структура

- `apps/api` — HTTP API.
- `apps/worker` — долгоживущий PostgreSQL Worker и точка подключения версионируемой симуляции.
- `packages/shared` — общие типы и утилиты.
- `packages/domain` — доменные контракты.
- `packages/simulation` — оболочка детерминированного Simulation Engine.
- `packages/persistence` — PostgreSQL/Drizzle persistence и миграции.
- `packages/gameplay` — транзакционные application services для membership и orders.
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

## Запуск API

```bash
corepack pnpm dev:api
```

Health-check: `GET http://127.0.0.1:3000/health`.

## Запуск Worker

Worker является отдельным процессом и запускается командой:

```bash
corepack pnpm dev:worker
```

Перед запуском необходимо задать `WORKER_ADAPTER_MODULE` — абсолютный путь к собранному JavaScript-модулю, который экспортирует `createWorkerAdapter(context)`. Адаптер предоставляет версионируемый ruleset, resolver с реальными phase handlers и функцию вычисления следующего дедлайна. В репозитории пока нет утверждённых игровых обработчиков; Worker намеренно не запускается с фиктивной no-op симуляцией.

Параметры polling/heartbeat задаются через `WORKER_IDLE_POLL_MS`, `WORKER_HEARTBEAT_MS` и `WORKER_REAPER_BATCH_SIZE`. Worker использует те же PostgreSQL и seed-encryption ключи, что API.

## Следующий этап: Stage 2 — вертикальный игровой прототип

Цель — провести первую тестируемую партию двух игроков: приглашение второго участника, регистрация стран, генерация карты, обязательный выбор официальной религии/идеологии по Q24, стартовая конфигурация (2 фабрики, 2 поля, шахта, столица, дополнительный слот — всего 7 зданий и 18 жителей), затем первые build/colonize приказы.

## Campaign invitations

Приглашения второго участника выдаются только на этапе начальной настройки кампании. В БД сохраняется SHA-256-хэш одноразового токена; срок по умолчанию — 7 дней, максимум — 30 дней. Токен возвращается создателю один раз; интеграция с email-провайдером пока не подключена. Принятие требует аутентифицированной сессии с совпадающим email. После появления initial world snapshot новые приглашения блокируются.

## Текущие ограничения

- Participant invitations/roles, audit trail и rate limiting для публичных auth endpoints пока не реализованы.
- Полный country setup (official system, стартовые здания/население, world snapshot) ещё не реализован; это Stage 2.
- Отдельные игровые phase handlers ещё не реализованы; Worker не подставляет no-op автоматически и требует явный adapter module.
- Country setup, приглашения и назначение государств остаются задачами Stage 2. World API требует явного безопасного projector; дефолтный сервер не возвращает сырой snapshot.
- Публичный API seed reveal и Web-клиент ещё не реализованы.
- Stage 1 DoD не достигнут: полного end-to-end цикла «приказ → worker → симуляция → snapshot → API» пока нет.

## Seed encryption configuration

Copy `.env.example` to `.env` for local development. The included `dev-v1` key is a public placeholder and must never be used for deployed or production campaigns. Production keys must be supplied through a protected environment, Docker secrets, Vault or KMS; never commit real key material. Keep every historical key version available until all campaigns encrypted with it have completed and their seeds have been revealed.
