# Документация Paper Wars: Rebirth

**Documentation Baseline v1.0**  
**Статус:** нормативная спецификация восстановлена по трём частям авторских материалов и зафиксирована в Markdown. Это документационный baseline, а не утверждение о готовности исполняемого приложения.

## Нормативные правила

- [Новые правила](rules/new-rules.md) — действующие игровые решения Q1–Q17, Q21–Q24.
- [Исторические правила](rules/legacy-rules.md) — сохранённые исторические формулировки и границы применимости.
- [Открытые вопросы](rules/open-questions.md) — Q18–Q20 как неподтверждённые сюжетные PROPOSAL; Q14 объединён с Q21.
- [Происхождение правил](rules/rule-provenance.md) — CONFIRMED / INFERRED / NEW DESIGN / PROPOSAL.

## Архитектура

- [Случайность, seed и commit-reveal](architecture/randomness.md).
- [Обработка хода, транзакции и Worker](architecture/turn-processing.md).
- [Разведка, руины, золото и доступ к находкам](architecture/discovery.md).
- [Информационная видимость и DTO-проекции](architecture/information-visibility.md).
- [Аутентификация и lifecycle кампании](architecture/authentication.md).

## Лор

- [Подтверждённый канон](lore/canon.md).
- [Неподтверждённые сюжетные предложения](lore/unconfirmed-proposals.md).

## План и полная восстановительная запись

- [Дорожная карта разработки](roadmap.md) — этапы 0–9, зависимости и Definition of Done.
- [Восстановленная спецификация](RECOVERED_SPECIFICATION.md) — сводная запись исходной реконструкции, включая архитектурные решения, границы восстановления и состояние репозитория.

## Первичные архивные материалы

- [VK discussions export](../VK_discussions_205658089_2026-11-20.docx)
- [VK wall export](../VK_wall_205658089_2026-11-20.docx)

## Статус реализации на 21 ноября 2026 года

Документы остаются нормативным Baseline; часть технических контрактов уже реализована и проверена:

- Stage 1.1 monorepo и базовый API skeleton merged в `main` (PR #3).
- Stage 1.2 PostgreSQL/Drizzle schema, SQL migrations и integration tests merged (PR #4).
- Stage 1.3 RNG/commit-reveal primitives, AES-256-GCM seed persistence, versioned key provider и random draw log merged (PR #5).
- Stage 1.4 scrypt auth, access JWT, refresh rotation/replay revocation, authenticated campaign create/list и atomic campaign+membership+first seed merged (PR #6).
- Stage 1.5 branded domain entities, order/event/snapshot/resolution contracts, versioned RulesetManifest и state compatibility migration merged (PR #7).
- Чистый GitHub Actions CI: build, typecheck, lint, format-check и 55 тестов прошли на PostgreSQL 18.7.

Ещё не реализованы: participant/role management, auth rate limiting/audit, исполняемый Simulation Engine, turn Worker, closeOrders/finalization, Stage 2 country setup (Q24, карта и старт 7/18), игровые world DTO и Web-клиент. Q18–Q20 остаются PROPOSAL и не входят в канон.

Изменения в действующих правилах после фиксации Baseline должны сопровождаться обновлением `new-rules.md`, `rule-provenance.md`, затронутой архитектуры и версии ruleset.
