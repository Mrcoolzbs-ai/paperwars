# Paper Wars: Rebirth

Технический каркас браузерной военно-политической стратегии. Игровые механики на Stage 1.1 ещё не реализованы.

## Текущий статус

**Documentation Baseline v1.0 зафиксирован. Stage 1.1 — monorepo bootstrap.** Ветка содержит границы пакетов, API health-check, базовые доменные контракты и smoke-тесты. PostgreSQL, миграции, RNG/seed service и обработка ходов добавляются последующими задачами.

## Документация и исходные материалы

Полный нормативный комплект Markdown находится в [документации](docs/README.md): игровые правила, provenance, открытые вопросы, архитектура и дорожная карта. Два исходных DOCX-файла сохранены без изменений в корне репозитория.

**Важно:** спецификация не означает, что механизмы уже реализованы. Q18–Q20 остаются сюжетными PROPOSAL и не входят в канон.

## Структура

- `apps/api` — HTTP API и точка запуска сервера.
- `packages/shared` — общие типы, идентификаторы, координаты и ошибки.
- `packages/domain` — платформенно-независимые доменные контракты.
- `packages/simulation` — оболочка Simulation Engine; разрешение хода пока не реализовано.
- `packages/persistence` — интерфейсы портов хранения, без конкретной БД.
- `tests` — интеграционные smoke-тесты.
- `docs` — Documentation Baseline v1.0 и roadmap.

## Требования

- Node.js 22 или совместимый поддерживаемый LTS-релиз.
- pnpm 9.15.0 или новее в рамках pnpm 9.

## Установка и проверки

```bash
corepack pnpm install
corepack pnpm format
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
```

## Запуск API

```bash
corepack pnpm dev:api
```

Health-check: `GET http://127.0.0.1:3000/health`.

## Ограничения Stage 1.1

- Нет игровых алгоритмов и фиктивных результатов симуляции.
- Доменный слой не зависит от HTTP или persistence.
- Simulation Engine не читает системное время и не использует глобальный RNG.
- API-модуль можно импортировать в тестах без запуска HTTP-сервера.
- Реальная БД, схема, миграции, RNG, зашифрованные seed и очередь Worker относятся к последующим задачам Stage 1.
