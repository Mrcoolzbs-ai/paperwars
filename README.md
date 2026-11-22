# Paper Wars: Rebirth

Браузерная пошаговая военно-политическая стратегия. Нормативная спецификация проекта находится в [Documentation Baseline v1.0](docs/README.md).

## Текущий статус

- Documentation Baseline v1.0 и базовые инфраструктурные этапы зафиксированы в `main`.
- **Stage 1** — monorepo, PostgreSQL persistence, deterministic RNG, authentication, campaign API и контракты симуляции.
- **Stage 2** — создание религий/идеологий до регистрации государства, модерация, лимиты систем, территория 5×5 и стартовые постройки.
- **Stage 3 — browser client (MVP)** — вход и регистрация, список/создание кампаний, создание социальных систем, панель модерации и форма основания государства.
- Клиент работает как статические HTML/CSS/JS-файлы и отдаётся тем же Fastify-сервером. Отдельный frontend build и Docker для запуска не нужны.
- **Полный игровой цикл ещё не реализован**: приказы, дипломатия, армия, исполнение ходов и отображение настоящего world snapshot остаются следующими этапами.

Спецификация и код не означают, что игра уже исполняет полный ход. Q18–Q20 остаются сюжетными PROPOSAL и не входят в канон.

## Структура

- `apps/api` — HTTP API и раздача браузерного клиента.
- `apps/web/public` — клиент Paper Wars (vanilla JavaScript, HTML и CSS).
- `packages/shared` — общие типы и утилиты.
- `packages/domain` — доменные контракты.
- `packages/world` — старт государства, территории и социальные системы.
- `packages/simulation` — оболочка детерминированного Simulation Engine.
- `packages/persistence` — PostgreSQL/Drizzle persistence и миграции.
- `tests` — smoke и интеграционные тесты.
- `docs` — Documentation Baseline v1.0 и roadmap.

## Требования

- Node.js 22 или новее.
- Corepack и pnpm 9.15.x.
- PostgreSQL 18 или новее.
- Docker Desktop не обязателен: PostgreSQL можно установить как обычную службу Windows.

## Windows: запуск без Docker

1. Обнови файлы клиента скриптом `update-paperwars-web-client.bat` (нужно только для уже скачанной старой копии проекта).
2. Убедись, что PostgreSQL запущен и настройки `DATABASE_URL` в `.env` соответствуют локальной базе.
3. Запусти `start-paperwars-postgresql19.bat` двойным щелчком.
4. Скрипт установит зависимости, применит миграции, запустит API и откроет браузер на `http://127.0.0.1:3000`.

Первая установка Node.js и PostgreSQL выполняется отдельно. Скрипт запуска не меняет существующий `.env`. Окно `Paper Wars API` должно оставаться открытым, пока используешь игру.

## Ручная установка и запуск

```bash
corepack pnpm install
cp .env.example .env
corepack pnpm --filter @paper-wars/persistence db:migrate
corepack pnpm --filter @paper-wars/api dev
```

Игровой интерфейс: `http://127.0.0.1:3000/`.

Проверка API: `http://127.0.0.1:3000/health`.

## Проверки

```bash
corepack pnpm format:check
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
```

GitHub Actions поднимает отдельный PostgreSQL service и выполняет миграционные integration tests автоматически.

## Социальные системы и модерация

Игрок отправляет религию или идеологию на проверку до регистрации государства. Одобрять и отклонять заявки могут только UUID, перечисленные в `SOCIAL_SYSTEM_ADMIN_USER_IDS` через запятую в `.env`. Не добавляй туда случайные или публичные UUID.

Доступность чужих социальных систем зависит от ruleset policy. Конкретный географический радиус и метрика расстояния исходными правилами не определены, поэтому сервер не выдумывает их.

## Текущие ограничения клиента

- Карта на обзорном экране пока схематическая; настоящий рельеф, реки и сохранённое состояние мира ещё не визуализируются из world snapshot.
- Стартовая территория 5×5 и размещение семи построек отправляются в API.
- Системы других игроков не становятся автоматически доступными без настроенной ruleset policy.
- Полный цикл «приказ → worker → симуляция → snapshot → API» ещё не достигнут.
- Invitations/roles, audit trail и rate limiting для публичных auth endpoints остаются отдельными задачами.

## Seed encryption configuration

Copy `.env.example` to `.env` for local development. The included `dev-v1` key is a public placeholder and must never be used for deployed or production campaigns. Production keys must be supplied through a protected environment, Docker secrets, Vault or KMS; never commit real key material. Keep every historical key version available until all campaigns encrypted with it have completed and their seeds have been revealed.
