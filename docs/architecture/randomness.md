# Случайность, seed и commit-reveal

**Baseline v1.0.** Все блоки ниже — нормативные спецификации, а не реализованный код.

## 5. Техническая спецификация случайности и seed

Все пункты этого раздела — нормативные контракты будущей реализации. Наличие спецификации не означает, что криптографический код уже реализован или проверен тестами.

### 5.1. Seed на каждый ход и жизненный цикл

- Для каждого хода кампании создаётся отдельный 32-байтовый seed через CSPRNG.
- Первый seed создаётся в той же транзакции БД, что и кампания.
- Запись первого seed имеет `turn_number = 1`.
- Commitment первого хода публикуется до открытия приёма приказов.
- Открытый seed не сохраняется в обычной таблице БД, логах или долговременном кэше.
- Seed хранится только в виде AES-256-GCM ciphertext.
- Worker получает seed через серверный сервис ключей, расшифровывающий его соответствующим ключом.
- Во время кампании API не раскрывает seed, HMAC или внутренний draw message.
- После завершения кампании записи переводятся в `revealed`, заполняется `revealed_at`, а API раскрывает исходные seed после серверного расшифрования. Если ход завершает кампанию, seed следующего хода не создаётся.

### 5.2. Нормативная модель `random_seeds`

| Поле | Тип | Назначение |
|---|---|---|
| `id` | UUID | Первичный ключ |
| `campaign_id` | UUID | FK на кампанию |
| `turn_number` | INT | Ход, для которого предназначен seed; нумерация с 1 |
| `commitment` | TEXT | SHA-256 commitment в hex |
| `encrypted_seed` | BYTEA | AES-256-GCM ciphertext |
| `encryption_key_version` | TEXT | Идентификатор версии ключа |
| `nonce` | BYTEA(12) | 12-байтовый GCM nonce |
| `auth_tag` | BYTEA(16) | 16-байтовый authentication tag |
| `rng_version` | TEXT | Версия RNG |
| `status` | ENUM/TEXT | `committed` / `revealed` |
| `revealed_at` | TIMESTAMP NULL | Время раскрытия |
| `created_at` | TIMESTAMP | Время создания |

Ограничения БД:

```sql
UNIQUE (campaign_id, turn_number),
UNIQUE (encryption_key_version, nonce),
CHECK (octet_length(nonce) = 12),
CHECK (octet_length(auth_tag) = 16)
```

Открытый seed и ключ шифрования в таблице не хранятся.

### 5.3. Ключи и AES-256-GCM

- Ключ — 32 байта.
- Seed — 32 байта.
- Nonce — 12 байт, генерируется CSPRNG.
- Auth tag — 16 байт и хранится отдельным полем.
- Ключ поступает из Docker secrets или защищённого хранилища секретов, не из БД.
- `encryption_key_version` указывает, какой ключ использовать при расшифровании.
- При ротации старые seed остаются зашифрованными прежними ключами; сервис ключей поддерживает старые версии до завершения всех использующих их кампаний.
- Одна версия ключа не может обозначать разные материалы ключа.

`SeedEncryptionContext` явно содержит `campaignId`, `turnNumber`, `rulesetVersion`, `rngVersion`. `encryptionKeyVersion` передаётся отдельно вместе с ключом.

AAD включает только:
- domain prefix `PW_AES_AAD_V1\0` (14 байт);
- версию кодирования `0x01`;
- `campaignId` (UTF-8 с uint16 BE length prefix);
- `turnNumber` (uint32 BE, от 1 до `0xFFFFFFFF`);
- `rngVersion` (UTF-8 с uint8 length prefix);
- `encryptionKeyVersion` (UTF-8 с uint8 length prefix).

`rulesetVersion` в AAD не включается. Она входит в commitment. При расшифровании строится в точности то же AAD; любое отличие AAD, ciphertext, nonce или auth tag приводит к отказу AES-GCM authentication.

Конфликт nonce обрабатывается только по ограничению `(encryption_key_version, nonce)`. Допускается повторить шифрование с новым nonce только при конфликте по этому уникальному ограничению. Вставка должна задавать конкретную цель конфликта, например `ON CONFLICT (encryption_key_version, nonce) DO NOTHING RETURNING id`. Конфликты по другим ограничениям, включая `(campaign_id, turn_number)`, должны приводить к ошибке и откату, а не к повторной генерации nonce.

### 5.4. Канонический commitment `commit-v1`

Commitment вычисляется как SHA-256 от бинарной структуры, а не от произвольной конкатенации строк.

Порядок полей:

| Поле | Кодирование |
|---|---|
| Domain prefix | `PW_COMMIT_V1\0`, **13 байт** UTF-8 |
| Version | 1 байт, `0x01` |
| `campaignId` length | uint16 BE |
| `campaignId` | UTF-8 |
| `turnNumber` | uint32 BE, диапазон 1…`0xFFFFFFFF`; JavaScript `Number.isSafeInteger` проверяется до сериализации |
| `rulesetVersion` length | uint8 |
| `rulesetVersion` | UTF-8 |
| `rngVersion` length | uint8 |
| `rngVersion` | UTF-8 |
| `seed` | ровно 32 байта |

Проверки длин выполняются в байтах UTF-8 до бинарной записи. Commitment имеет один формат для первого и всех последующих ходов:

`SHA-256(encodeCommitment(campaignId, turnNumber, rulesetVersion, rngVersion, seed))`.

`turnNumber` в commitment и RNG — один и тот же номер хода. Первый seed связан с ходом 1.

### 5.5. Канонический HMAC draw message `enc-v1`

Используется length-prefixed binary encoding. Склейка текстовых частей через `:` запрещена: идентификаторы могут содержать двоеточия и другие произвольные символы.

Порядок полей:

| Поле | Кодирование |
|---|---|
| Domain prefix | `PW_DRAW_V1\0`, **11 байт** UTF-8 |
| Version | 1 байт, `0x01` |
| `campaignId` length | uint16 BE |
| `campaignId` | UTF-8 |
| `turnNumber` | uint32 BE, диапазон 1…`0xFFFFFFFF`; JavaScript `Number.isSafeInteger` проверяется до сериализации |
| `rngVersion` length | uint8 |
| `rngVersion` | UTF-8 |
| `domain` length | uint8 |
| `domain` | UTF-8 |
| `drawId` length | uint16 BE |
| `drawId` | UTF-8 |
| `attempt` | uint64 BE, ровно 8 байт |

Проверки:
- `turnNumber` — безопасное целое JavaScript `number`, от 1 до `0xFFFFFFFF`.
- `attempt` — `bigint`, начальное значение `0n`, допустимый диапазон `0n … (1n << 64n) - 1n`.
- Проверка `attempt` выполняется до сериализации. Искусственного лимита попыток нет; ошибка возникает только при реальном исчерпании uint64.
- Сериализация — ровно 8 байт unsigned big-endian (`writeBigUInt64BE`).
- Длины строк проверяются в байтах UTF-8 до сериализации: campaignId/drawId — uint16; rngVersion/domain — uint8.

### 5.6. Domain-separation

Каждый формат использует собственный префикс:

| Формат | Prefix | Длина |
|---|---|---:|
| `commit-v1` | `PW_COMMIT_V1\0` | 13 байт |
| `enc-v1` | `PW_DRAW_V1\0` | 11 байт |
| AAD | `PW_AES_AAD_V1\0` | 14 байт |

Префиксы не переиспользуются между форматами. Изменение префикса требует изменения версии соответствующего формата. Точные длины: `PW_COMMIT_V1\\0` — 13 байт, `PW_DRAW_V1\\0` — 11 байт, `PW_AES_AAD_V1\\0` — 14 байт.

### 5.7. RNGContext и равномерная выборка

`RNGContext` передаёт:
- `campaignId`;
- `turnNumber`;
- `rngVersion`;
- `turnSeed` (32 байта).

Текущая версия RNG: `rng-v1`.

Для `drawUniform(domain, drawId, min, max)`:
- `min` и `max` — безопасные целые JavaScript numbers;
- `max >= min`;
- `range = max - min + 1` не превышает `2^32` и не переполняется;
- берётся первое uint32 BE из HMAC-SHA-256;
- применяется rejection sampling: `limit = 2^32 - (2^32 mod range)`;
- значение принимается, если оно меньше `limit`; иначе создаётся следующий draw с увеличенным `attempt`;
- простой modulo без rejection sampling запрещён.

Для `drawWeighted`:
- таблица не пуста;
- веса — положительные безопасные целые числа;
- сумма весов не превышает `2^32`;
- порядок записей таблицы стабилен внутри версии ruleset;
- используется rejection sampling по общей сумме весов.

Домены включают как минимум `discovery`, `battle`, `general`, `event`, `weather`, `ruin`, `gold`. Draw ID привязан к сущности/операции, а не к порядку HTTP-запросов. Для rejection sampling `attempt` кодируется отдельным uint64 полем, не строковым суффиксом.

### 5.8. Внутриигровой идентификатор сезона

Календарный год не используется. Формат — `Y{year}S{seasonIndex}`.

| SeasonIndex | Сезон |
|---:|---|
| 1 | Весна |
| 2 | Лето |
| 3 | Осень |
| 4 | Зима |

При шести ходах на сезон:
- 1–6 — Y1S1;
- 7–12 — Y1S2;
- 13–18 — Y1S3;
- 19–24 — Y1S4;
- 25 — Y2S1.

Пример draw ID для золотой шахты: `gold:deposit_d78:season:Y1S3:check`.

### 5.9. Commit-reveal и ограничения

**Во время кампании (MVP):**
- commitment публикуется до открытия приёма приказов каждого хода;
- seed остаётся секретным;
- API не раскрывает seed, HMAC или draw message;
- игроки видят результаты бросков в обычных отчётах;
- выборочная публичная проверка отдельных бросков не предоставляется.

**После завершения кампании:**
- раскрываются исходные seed всех ходов;
- игроки могут пересчитать commitment и воспроизвести случайные результаты по публичным версиям RNG и ruleset.

Commit-reveal доказывает неизменность seed после публикации commitment, но не честность его первоначального выбора сервером.

VRF, zero-knowledge proof, per-draw commitments и внешний источник энтропии — FUTURE DESIGN, не входят в MVP. Per-draw commitment не позволяет проверить HMAC без seed; публичный VRF output может раскрыть скрытые результаты разведки, поэтому потребовал бы отдельной модели приватности.
