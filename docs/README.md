# Документация Paper Wars: Rebirth

**Documentation Baseline v1.0**  
**Статус:** игровые правила и технические контракты Baseline v1.0 сведены в Markdown. Это документационный baseline, а не утверждение о готовности исполняемого приложения. Исторические legacy-правила и часть архивных таблиц ещё требуют полной транскрипции и сверки.

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
- [Религии и идеологии](architecture/social-systems.md).
- [Графический Web-клиент](architecture/web-client.md) — карта мира, редактор стартовой территории и подключение к API.

## Лор

- [Подтверждённый канон](lore/canon.md).
- [Неподтверждённые сюжетные предложения](lore/unconfirmed-proposals.md).

## Единая спецификация и план

- [Единая спецификация проекта](SPECIFICATION.md) — главный вход в Baseline v1.0: игровые правила, архитектурные контракты, статус реализации и известные расхождения.
- [Восстановительная запись](RECOVERED_SPECIFICATION.md) — исторический отчёт о реконструкции и её ограничениях на 21 ноября 2026 года.
- [Дорожная карта разработки](roadmap.md) — этапы 0–9, зависимости и Definition of Done.

## Первичные архивные материалы

- [VK discussions export](../VK_discussions_205658089_2026-11-20.docx)
- [VK wall export](../VK_wall_205658089_2026-11-20.docx)

## Статус реализации на 24 ноября 2026 года

Документация Baseline v1.0 находится в Markdown; единая точка входа — [SPECIFICATION.md](SPECIFICATION.md). Описание правила, наличие UI и работающий engine-контур — разные статусы; они не означают завершённости всей механики.

В `main` влиты Stage 1.1–1.5 (PR #3–#7): monorepo/API skeleton, PostgreSQL/Drizzle, RNG/commit-reveal, аутентификация, доменные контракты и manifest ruleset.

**Draft PR #15** ([feat(web): add Paper Wars browser client MVP](https://github.com/Mrcoolzbs-ai/paperwars/pull/15)) остаётся открытым в `stage-3-browser-client`, основан на `stage-2-country-setup`, не влит. Клиентский вертикальный срез (авторизация, кампании, seeded-карта, основание страны, культурные и социальные карточки) предварительно принят как отдельный ограниченный инкремент. Это не закрытие полного Stage 2 DoD.

В PR #15 был добавлен начальный Stage 1.7: pure Simulation Engine проверяет совместимость ruleset/snapshot и finalized orders, вызывает resolver и ведёт авторитетный журнал RNG draws. Этот инфраструктурный срез прошёл CI: Build, Typecheck, Lint, Format check и 79/79 тестов в 15 файлах ([run 45078180497](https://github.com/Mrcoolzbs-ai/paperwars/actions/runs/45078180497)).

Инфраструктурный инкремент Stage 1.8 расширен: транзакционные order CRUD текущей страны/хода, отзыв подтверждения, deadline guards, подтверждение и атомарное `closeOrders`; очередь включает TurnJob, claim через `SKIP LOCKED`, lease renewal, reaper и fenced `completeTurnJob`.

Контрольный CI расширенного инкремента прошёл Build, Typecheck, Lint, Format check и **91/91 PostgreSQL/unit tests в 16 файлах** ([run 45113619602](https://github.com/Mrcoolzbs-ai/paperwars/actions/runs/45113619602)). Проверены CRUD/ownership приказов, отзыв подтверждения после изменений, deadline guards, закрытие хода, выход участника, lease/reaper и fencing.

**PR #44** ([feat(map): move construction and colonization orders to global map](https://github.com/Mrcoolzbs-ai/paperwars/pull/44)) — открытый feature PR, ещё не влитый в `main`. В его ветке добавлены concrete baseline handlers для `construction` и `colonization`, запуск TurnWorker рядом с API и транзакционное сохранение результатов. На ход у страны не более 3 ОД; лимит проверяется при создании приказа на сервере и повторно в resolver. Колонизация берёт квадрат 3×3 вокруг выбранной точки и проходит только если захватывает хотя бы одну новую клетку суши; свободные клетки воды/рек в этом квадрате тоже занимают территорию с нулевым населением. На каждую новую клетку суши отдельно выполняется d100: 1 — руины, 2–99 — обычная клетка, 100 — золото. Результат хранится постоянно, повторный бросок исключён; захват уже открытой клетки не раскрывает находку новому владельцу.

Незавершённые части Stage 2 и последующих этапов:
- приглашения второго игрока, полноценные membership/roles и обязательное административное согласование религий/идеологий (текущий автодоступ в PR #15 — известное расхождение с Baseline);
- остальные правила и фазы полного цикла хода: экономика, сезоны, исследования руин, разработка золота, дипломатия и армия;
- полные DTO-проекции по видимости и защита закрытых данных.

Границы и перечень предварительно принятых/незавершённых пунктов подробно описаны в [roadmap.md](roadmap.md) и [SPECIFICATION.md](SPECIFICATION.md). Q18–Q20 остаются PROPOSAL и не входят в канон.
