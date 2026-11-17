# Hermes v12, удаление провайдеров/моделей и dsh: дизайн

Дата: 2026-11-17
Статус: к реализации
Связанное исследование: `docs/research/2026-11-17-provider-sync-current-state.md`

## 1. Цель

Сделать `provider-sync` корректным для реальных конфигов Hermes v12 и добавить управляемое удаление провайдеров и моделей во всех поддерживаемых harness'ах, не ломая основную модель «сервер — источник истины для состава моделей».

Успех:

- `add` и `sync` обновляют Hermes независимо от того, использует конфиг `api`/`default_model`/`models`-список или legacy `base_url`/`model`/`models`-словарь;
- обе поверхности Hermes (`providers:` и `custom_providers:`) синхронизируются;
- `remove` удаляет провайдера/модель из OpenCode, Hermes и dsh, а следующий `sync` не возвращает удалённое;
- `restore` снимает запрет;
- dsh использует default context window 1 000 000 и умеет опрашивать Gemini-совместимые endpoint'ы;
- OpenCode 2.x может перейти из legacy-формы в native, чтобы `releaseDate` работал в desktop picker;
- документация и help соответствуют поведению.

## 2. Архитектура

### 2.1. Hermes: единая модель документа

Вместо `hermesDoc()` с одной выбранной поверхностью вводится `hermesDocs(text)`:

```js
{
  lines, eol,
  docs: [
    { form: "dict", section: "providers", entries: [...], error: null },
    { form: "list", section: "custom_providers", entries: [...], error: null }
  ],
  entries: [...] // плоский список с ссылкой на doc
}
```

Каждая запись нормализуется:

```js
{
  key, name, base_url, api_key, key_env, key_cmd,
  model,                 // default_model или model
  models: [{ id, ctx, extra }],
  modelsShape: "map" | "list",
  modelStyle: "scalar" | "object", // для list
  enabled,
  flow,
  section,               // providers | custom_providers
  fldInd, mdlInd, ctxInd, idx, end, modelsIdx, blockEnd
}
```

Правила:

- `api`/`url`/`base_url` читаются в этом порядке приоритета; `base_url` остаётся внутренним именем.
- `default_model`/`model` читаются; внутреннее имя — `model`.
- `models`-словарь и `models`-список читаются оба.
- `enabled: false` — запись не синхронизируется, но отображается в `list`.
- неизвестное поле внутри записи не прерывает разбор: запись остаётся управляемой, если её `models`-блок можно безопасно переписать; иначе помечается `unparsed`.
- ошибка одной поверхности не мешает другой.
- `flow`-записи читаются, но не переписываются (как сейчас).

Запись:

- в `providers:` новые записи пишутся канонически: `api`, `default_model`, `models` (словарь или список — по форме существующей записи; новая — словарь).
- в `custom_providers:` остаются `base_url`, `model`, `models` (словарь или список).
- существующая запись сохраняет свои имена полей: `api` не заменяется на `base_url` и наоборот.
- `models`-список сохраняется списком, если у моделей нет ctx; если появляется ctx, список переписывается в список объектов `- id: ...` + `context_length`, что Hermes принимает через `_normalize_provider_models`.
- `add --model` обновляет существующее `default_model`/`model`.

`add`:

- ищет base URL во всех документах;
- если найдено несколько — обновляет все совпадения и сообщает об этом;
- если не найдено — создаёт в `providers:`, если он есть; иначе в `custom_providers:`; если нет ни одной — создаёт `providers:`.

`sync`:

- обходит обе поверхности;
- пропускает `enabled: false`;
- правки применяет снизу вверх по общему `lines`, чтобы индексы не съезжали;
- отчёт помечает секцию для каждой записи.

`list`:

- печатает обе секции; при наличии обеих — заметку о дублировании;
- показывает `disabled` и количество моделей.

### 2.2. Удаление: команды и состояние

Новые команды:

```text
provider-sync remove <id> [--model M]... [--target all|opencode|hermes|dsh]
                          [--profile NAME] [--apply] [--dry-run]
                          [--force] [--purge-credentials] [--keep-exclusions]
provider-sync restore <id> [--model M]... [--target ...]
```

- Без `--model` — удалить провайдера.
- С `--model` (повторяемый) — удалить модели.
- По умолчанию — только отчёт. `--apply` пишет. `--dry-run` всегда выигрывает.
- `--target` — как у `add`.
- `--force` — разрешить удаление при ссылке из default-модели.
- `--purge-credentials` — удалить credential-запись dsh, если она не используется другими route.
- `--keep-exclusions` — при удалении провайдера сохранить его tombstones.

Tombstones хранятся в `~/.config/provider-sync/state.json` (override `PS_STATE` для тестов):

```json
{
  "version": 1,
  "excluded": [
    {
      "target": "hermes",
      "provider": "ollama-launch",
      "baseURL": "http://127.0.0.1:11434/v1",
      "models": ["qwen3.6:27b-coding-nvfp4"]
    }
  ]
}
```

- Матчинг: `target` + (`provider` или нормализованный `baseURL`) + model id.
- `sync`, `add`, `set-ctx` фильтруют серверный список через tombstones до `reconcile`.
- В отчёте: `note: N model(s) hidden by provider-sync remove`.
- `list` показывает `N hidden`.
- Tombstone не удаляется автоматически; `restore` снимает его.
- При удалении провайдера tombstones удаляются, если не передан `--keep-exclusions`.

Удаление провайдера:

| Harness | Действие |
| --- | --- |
| OpenCode | удалить `provider.<id>` и `providers.<id>`, если есть оба; убрать id из `disabled_providers` |
| Hermes | удалить запись из обеих поверхностей по id/base URL; при неоднозначности — ошибка без `--force` |
| dsh | удалить `providers.<id>`; при `--purge-credentials` — store-запись, если ref не используется другими route |

Удаление модели:

| Harness | Действие |
| --- | --- |
| OpenCode | удалить `models.<id>` из выбранной формы |
| Hermes | удалить запись/элемент списка из обеих поверхностей |
| dsh | удалить элемент `models[]` |

Default-ссылки:

- Hermes: `model.default`, `model.provider`, `fallback_providers`;
- OpenCode: top-level `model`, `small_model`;
- dsh: default-route, если присутствует.

Если ссылка указывает на удаляемое — отказ без `--force`. С `--force` — предупреждение, default не переписывается.

Credentials:

- OpenCode: ключ в entry удаляется вместе с entry; `auth.json`/`opencode.db` не трогаются, выводится подсказка.
- Hermes: литеральный `api_key` уходит с entry; `key_env`/`.env` не трогаются, выводится подсказка.
- dsh: `--purge-credentials` удаляет store-запись только если ref не используется другими route; иначе сообщение.

Атомарность:

1. прочитать все конфиги;
2. построить изменения в памяти;
3. проверить парсинг/валидацию;
4. записать каждый файл атомарно с backup;
5. при ошибке восстановить уже записанные файлы;
6. только после успеха трогать credentials store.

### 2.3. dsh

- `DEFAULT_CTX = 1_000_000`.
- `DSH_PROTOCOLS` + `google-generative-ai`.
- Probe Gemini: `GET {base}/models` с `x-goog-api-key` (или `?key=`), ответ `{ models: [{ name, inputTokenLimit, supportedGenerationMethods }] }`.
- Имя `models/gemini-...` нормализуется в `gemini-...`.
- `add` пробует Gemini, если OpenAI/Anthropic не ответили, и пишет `api: google-generative-ai`.

### 2.4. OpenCode 2.x

Новая команда:

```text
provider-sync migrate --target opencode [--apply] [--dry-run]
```

- Находит legacy `provider.<id>`.
- Конвертирует в native `providers.<id>`:
  - `npm` → `package`;
  - `options` → `settings`;
  - модели: `modalities.input` → `capabilities.input`, `tool_call` → `capabilities.tools`, `reasoning` → `capabilities.reasoning`, `release_date` → `releaseDate`;
  - `limit` сохраняется;
  - прочие поля сохраняются.
- Удаляет legacy-запись только после успешной записи native.
- Backup + schema-валидация + read-back.
- Без `--apply` — отчёт.

Если конвертация невозможна без потери полей — запись пропускается с причиной, legacy остаётся.

## 3. Ошибки и коды возврата

- `0` — успех/запланировано.
- non-zero — id не найден, default-ссылка без `--force`, ошибка записи, partial failure.
- `not found — skipped` для отсутствующего harness — не ошибка.
- Повторное удаление отсутствующего — `0` с `nothing to remove` (идемпотентность).

## 4. Тестирование

- Hermes: канонический v12 (`api`, `default_model`, `models` списком), обе поверхности, `enabled: false`, неизвестное поле в одной записи, `add --model`, запись в v12-диалекте.
- Удаление: provider/model во всех harness'ах, tombstones, `sync` не возвращает, `restore`, dry-run, backup, default-ref, credentials, partial failure.
- dsh: default 1M, Gemini probe, удаление модели.
- OpenCode: legacy/native удаление, migrate, `releaseDate`.
- Регрессия: весь `npm test`.

## 5. Документация

- README: Hermes обе поверхности и канонические поля; dsh default 1M; dsh 4 протокола; remove/restore/migrate; tombstones.
- AGENTS: обновить команды, правила, dsh, Hermes.
- CHANGELOG: Unreleased.
- HELP: новые команды и флаги.
