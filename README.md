# Paper Wars: Rebirth

Браузерная пошаговая военно-политическая стратегия. Нормативная спецификация проекта находится в [Documentation Baseline v1.0](docs/README.md).

## Текущий статус

- **Documentation Baseline v1.0** зафиксирован в `main`.
- **Stage 1.1**: TypeScript monorepo, границы пакетов, Fastify health-check и базовые smoke tests — merged.
- **Stage 1.2**: PostgreSQL persistence, Drizzle schema, SQL migrations и integration tests — в разработке.
- Игровые алгоритмы, RNG/seed service, закрытие приказов и Worker добавляются поэтапно после соответствующих инфраструктурных контрактов.

Спецификация и псевдокод не означают, что функциональность уже реализована. Q18–Q20 остаются сюжетными PROPOSAL и не входят в канон.

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

## Запуск API

```bash
corepack pnpm dev:api
```

Health-check: `GET http://127.0.0.1:3000/health`.

## Текущие ограничения

- Authentication flow и refresh-token storage пока не реализованы.
- Simulation Engine пока не исполняет игровые ходы.
- RNG, commit-reveal, шифрование seed и Worker orchestration будут добавлены отдельными задачами.
- Игровые механики не добавляются в Stage 1.2.
