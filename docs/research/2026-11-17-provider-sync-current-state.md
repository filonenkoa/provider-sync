# provider-sync: текущее состояние, дефекты и пробелы

Дата: 2026-11-17
Версия инструмента: 1.2.2
Проверено на: OpenCode 2.3.0, Hermes Agent 0.22.5, upstream `deepseek-ai/deepseek-harness`.
Локально dsh не установлен (`~/.dsh` отсутствует), поэтому его поведение проверено по исходникам.

## 1. Краткий вывод

1. `add` пишет OpenCode и не пишет Hermes не потому, что Hermes не поддерживается, а потому, что Hermes-upsert падает на разборе живого `~/.hermes/config.yaml`. OpenCode к этому моменту уже записан.
2. Причина падения — баг в регулярном выражении `lib/hermes-yaml.js:343`: альтернативы `DICT_FIELDS` не сгруппированы, поэтому каноническое поле `default_model:` матчится как `model:`.
3. Это не единственная проблема Hermes. Парсер не понимает канонический формат Hermes v12: `api:` вместо `base_url:`, `default_model:` вместо `model:`, `models:` списком.
4. В живом конфиге одновременно есть `providers:` и `custom_providers:`. Hermes читает и объединяет обе поверхности, а `provider-sync` выбирает только `providers:`.
5. Удаления нет ни для провайдеров, ни для моделей. `sync` удаляет только модели, которых больше нет на сервере, и возвращает модели, удалённые пользователем вручную, если сервер их всё ещё отдаёт.
6. У dsh не поддерживается протокол `google-generative-ai` и неверен default context window (`262144` вместо `1_000_000`).
7. У OpenCode остаётся миграционная проблема: живой конфиг — legacy `provider.<id>`, а исправление `releaseDate` для desktop-picker работает только в native `providers.<id>`.

## 2. Что происходит сейчас

### 2.1. Порядок записи в `add`

В `bin/provider-sync.js`:

- `cmdAdd` начинается около строки 1833;
- OpenCode записывается в блоке `if (wantOc)` — около 2028;
- Hermes вызывается позже — около 2045:

```js
if (wantH)
  try { hres = hermesUpsert({ ...hargs, dryRun: false }); }
  catch (e) { hres = { status: "error", why: ... }; }
```

При ошибке Hermes OpenCode уже записан. Это не транзакция «всё или ничего», и `written:` честно показывает `skipped — ...`, но пользователь видит именно то, что описал: OpenCode обновился, Hermes — нет.

### 2.2. Живой результат

```text
hermes (~/.hermes/config.yaml): providers: line 9: "default_model:" holds a nested block provider-sync does not manage — skipped
dsh (~/.dsh): not found — skipped
```

`add` в этой же ситуации возвращает в блоке `written:`:

```text
hermes    ~/.hermes/config.yaml  skipped — providers: line 9: "default_model:" ...
```

### 2.3. Живой Hermes-конфиг

```yaml
providers:
  ollama-launch:
    api: http://127.0.0.1:11434/v1
    default_model: qwen3.6:35b-a3b-coding-nvfp4
    models:
      - qwen3.6:35b-a3b-coding-nvfp4
      - qwen3.6:27b-coding-nvfp4
      - qwen3.5:35b-a3b-coding-nvfp4
    name: Ollama
```

Ниже в том же файле:

```yaml
custom_providers:
  - name: Local (llama.cpp)
    base_url: http://127.0.0.1:8080/v1
    ...
```

То есть Hermes-конфиг содержит обе поверхности. `provider-sync list --target hermes` показывает только `providers` и диагностирует ошибку, а восемь записей из `custom_providers` не показывает и не синхронизирует.

## 3. Hermes: четыре дефекта, а не один

### 3.1. Баг регулярки: `default_model` матчится как `model`

`lib/hermes-yaml.js:264`:

```js
const DICT_FIELDS = "name|base_url|api_key|key_env|model|models|models_discovered|discover_models|free_only";
```

`lib/hermes-yaml.js:343`:

```js
if (indentOf(f) === fi && new RegExp("^ {" + fi + DICT_FIELDS + ":").test(f))
  throw new Error(`providers: line ${j + 1}: "${f.trim().split(":")[0]}:" holds a nested block provider-sync does not manage`);
```

Из-за отсутствия группировки выражение означает:

```text
^ {fi}name | base_url | api_key | ... | model | models | ...
```

а не:

```text
^ {fi}(?:name|base_url|...|model|models|...):
```

Строка `    default_model: ...` содержит подстроку `model:` и попадает под проверку «неизвестное вложенное поле». Отсюда текст ошибки про `default_model:`.

### 3.2. Парсер не понимает канонический Hermes v12

Документация Hermes (`website/docs/integrations/providers.md`, раздел Named Custom Providers) говорит:

- `api` — endpoint, `base_url`/`url` — принятые алиасы;
- `default_model` — каноническое имя поля, legacy `model` — алиас;
- `models` может быть словарём или списком;
- `enabled: false` скрывает запись;
- `transport`, `key_cmd`, `api_key_env` и другие поля допустимы.

Что делает `provider-sync`:

- в `parseHermesProviders` (строки 320–326) читает только `name`, `base_url`, `api_key`, `key_env`, `model`, `models_discovered`;
- `api` молча игнорирует;
- `default_model` не читает (а до исправления regex — падает на нём);
- `models:` разбирает только как mapping через `parseModelsBlock`; список `- model-id` даёт ноль моделей;
- `enabled` не читает и не пропускает disabled-записи.

Следствие: даже после исправления регулярки живая запись `ollama-launch` разберётся как запись без base_url и с 0 моделей. `sync` попробует перезаписать её модели в mapping-форме, а `add` не найдёт её по base URL и создаст дубликат.

Hermes принимает `models` и списком, и словарём — это подтверждается `_normalize_provider_models` в `hermes_cli/config_providers.py` (строки 155–187).

### 3.3. Две поверхности Hermes: `providers:` и `custom_providers:`

`hermesDoc()` (`bin/provider-sync.js:934`) устроен так:

```js
const dict = parseHermesProviders(text);
if (dict) return { form: "dict", ..., error: dict.error ?? null, ... };
const list = parseHermes(text);
...
```

Если `providers:` существует, возвращается только он — даже если `parseHermesProviders` вернул ошибку. До `custom_providers:` управление не доходит.

При этом Hermes:

- читает обе поверхности;
- объединяет их в `get_compatible_custom_providers()`;
- дедуплицирует по `(name, base_url, model)`;
- `providers_dict_to_custom_providers()` пропускает только записи с `enabled: false`.

В живом конфиге это не теория: `providers:` — одна запись, `custom_providers:` — восемь.

### 3.4. Запись в неканоническом формате

`renderProviderEntry` (`bin/provider-sync.js:365`) для новой записи в `providers:` пишет:

```yaml
name: ...
base_url: ...
api_key: ...
model: ...
models:
  model-id: {}
```

Hermes принимает это как алиасы, поэтому «работает». Но:

- это не тот формат, который пишет сам Hermes;
- `api`/`default_model` не используются;
- список моделей превращается в mapping;
- другие инструменты, читающие конфиг строго, могут не понять запись;
- при обновлении существующей канонической записи `hermesUpsert` не обновляет `default_model` вовсе: в ветке `found` (`bin/provider-sync.js:1074–1088`) меняются только `models` и ключ. То есть `add --model M` для уже существующей записи молча игнорируется.

### 3.5. Один неизвестный field убивает весь раздел

`parseHermesProviders` при ошибке в любой записи возвращает `entries: []` и `error`, а `syncHermes` сразу делает `return`:

```js
if (h.error) { ... return { status: "no-section", why: h.error }; }
```

Одно поле, которое provider-sync не знает, отключает управление всеми провайдерами Hermes.

### 3.6. Тесты закрепляют неверную модель

`test/hermes-parse.test.js` тестирует только legacy `custom_providers` с `base_url`/`model` и mapping-моделями. `test/hermes-write.test.js` ожидает в `providers:` поля `base_url` и `models:` mapping. Канонического v12-фикстура с `api`, `default_model` и `models:` списком нет.

## 4. OpenCode: форма конфига и desktop picker

### 4.1. Что сейчас

Живой `~/.config/opencode/opencode.jsonc` — legacy:

```jsonc
"provider": {
  "ollama-local": {
    "npm": "@ai-sdk/openai-compatible",
    ...
  }
}
```

Установлен OpenCode 2.3.0, есть `~/.local/share/opencode/opencode.db`.

`provider-sync` корректно определяет форму через `providerShape`:

- `providers.<id>` → native;
- иначе `provider.<id>` → legacy;
- новый id в конфиге без `providers` → legacy.

Это правильно с точки зрения «не создавать второй shape, который затенит существующий». Но есть последствия.

### 4.2. `release_date` не помогает после миграции 2.x

`release_date` пишется в legacy-модели, `releaseDate` — в native. OpenCode 2.x при миграции legacy `release_date` отбрасывает. Значит:

- пока конфиг остаётся legacy, desktop/web picker может скрывать модели без native `releaseDate`;
- `sync --apply` пишет `release_date`, но это не гарантирует видимость после миграции;
- новый провайдер, добавленный в legacy-конфиг, тоже получит `release_date`, а не `releaseDate`.

README/AGENTS описывают это как caveat, но функционально пользователю это не помогает.

### 4.3. Удаление в OpenCode

Доступен только ручной workaround — добавить id в `disabled_providers`. `sync` такие провайдеры пропускает. Но:

- это не удаление;
- для моделей аналога нет;
- `disabled_providers` не чистится автоматически.

## 5. dsh: два расхождения с upstream

### 5.1. Не поддерживается `google-generative-ai`

`bin/provider-sync.js:722`:

```js
const DSH_PROTOCOLS = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);
```

Upstream `llm-pi-ai/src/provider.ts` поддерживает четыре протокола:

```ts
'openai-completions'
'openai-responses'
'anthropic-messages'
'google-generative-ai'
```

`probeDsh` для неизвестного протокола возвращает `unsupported`, `syncDsh` печатает:

```text
dsh protocol "google-generative-ai" is not one this build can serve — provider-sync cannot interrogate it
```

`add` пробует только `anthropic-messages` как альтернативу, поэтому Gemini-совместимый endpoint зарегистрировать через dsh-таргет нельзя.

### 5.2. Неверный default context window

`bin/provider-sync.js:1569`:

```js
const DEFAULT_CTX = 262144; // dsh's provider default when contextWindow is unset
```

Upstream `llm-pi-ai/src/config.ts:78`:

```ts
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
```

`defaultContextWindow` по умолчанию равен этому значению.

Последствия:

- `eff(c)` в `syncDsh` сравнивает серверный ctx не с тем default, который реально применит dsh;
- возможны ложные «in sync»;
- возможны лишние явные записи `contextWindow`;
- отчёты `~ ctx ... default 262144` вводят в заблуждение.

README (`README.md:196`) повторяет неверное число.

### 5.3. У dsh нет per-model `disabled`

В схеме dsh у модели есть `id`, `name`, `contextWindow`, `maxTokens`, `input`, `reasoningEfforts`, `compat`, но нет `enabled`/`disabled`. `modelOverrides` тоже не отключает модель, а только переопределяет поля. Поэтому «удалить модель» в dsh = убрать её из `models` списка, но `sync` вернёт её обратно с сервера.

## 6. Удаление провайдеров и моделей

### 6.1. Сейчас удаления нет

В CLI есть только:

```text
list
sync
add
set-ctx
```

Ни `remove`, ни `delete`, ни `prune`. Провайдер удаляется только ручной правкой файла — что противоречит правилу «never hand-edit the files this tool manages».

Модели удаляются автоматически только в одном случае: если сервер их больше не отдаёт. Это делает `reconcile` (`bin/provider-sync.js:902–923`) для OpenCode, `syncHermes` (1180) и `syncDsh` (1612).

### 6.2. Почему ручное удаление модели не работает

1. Пользователь удаляет модель из `~/.hermes/config.yaml` или OpenCode.
2. Запускает `provider-sync sync --apply`.
3. Сервер всё ещё отдаёт эту модель.
4. `reconcile` видит её в `server`, не видит в `models`, добавляет обратно.

То же для `add`: `add` вызывает `reconcile` и тоже возвращает модель. То есть любое удаление модели вручную будет отменено следующим `sync`/`add`, пока сервер её отдаёт.

Для провайдера такой проблемы нет: `sync` не создаёт провайдеров, только `add`. Но `add` после удаления провайдера может создать его заново.

### 6.3. Ограничения дизайна

1. Сервер — источник истины для состава моделей. Нельзя просто перестать добавлять новые модели.
2. Нужно хранить намерение пользователя отдельно от конфига: в OpenCode/Hermes/dsh нет общего поля «эта модель скрыта/удалена». Hermes `enabled: false` работает только на уровне провайдера. dsh `disabled` не имеет. OpenCode `disabled_providers` — только провайдер.
3. Провайдеры идентифицируются по-разному. OpenCode — по id, Hermes — по id в mapping или base URL в списке, dsh — по id. Плюс две поверхности Hermes.
4. Удаление провайдера может сломать default-модель.
5. Ключи могут лежать вне конфига: OpenCode `auth.json`/`opencode.db`, Hermes `.env`, dsh `.credentials.yaml`.
6. Нужна атомарность: удаление из трёх harness'ов не должно оставить половину состояния при ошибке.

## 7. Что требуется исправить

### P0 — Hermes

1. Исправить regex `lib/hermes-yaml.js:343`.
2. Добавить канонические поля Hermes v12 в парсер: `api`/`url`/`base_url`, `default_model`/`model`, `models` списком и словарём, `enabled`, `transport`, `key_cmd`, `api_key_env`.
3. Не прерывать разбор всего раздела из-за одной записи.
4. Синхронизировать обе поверхности Hermes.
5. Писать в диалекте записи: `api`/`default_model` для v12, `base_url`/`model` для legacy; сохранять форму `models`.
6. Обновлять `default_model` при `add --model`.

### P1 — удаление

1. Добавить `remove`/`restore`.
2. Хранить tombstones для моделей, чтобы `sync` их не возвращал.
3. Удалять провайдера из обеих форм OpenCode и обеих поверхностей Hermes.
4. Проверять default-ссылки; `--force` для продолжения.
5. Аккуратно работать с credential store; `--purge-credentials`.
6. Атомарная запись с rollback.
7. Тесты на удаление и отсутствие воскрешения моделей.

### P2 — dsh

1. Заменить `DEFAULT_CTX` на `1_000_000`.
2. Добавить `google-generative-ai` в `DSH_PROTOCOLS` и probe.

### P3 — OpenCode 2.x

1. Решить, что делать с legacy-конфигом на OpenCode 2.x: `migrate`-команда или native-запись для новых провайдеров.
2. Обновить README/AGENTS/CHANGELOG.

## 8. Итог

Сейчас `provider-sync` нельзя считать корректным для Hermes v12: он падает на каноническом `default_model`, не понимает `api` и `models` списком и управляет только одной из двух поверхностей. Поэтому `add` и `sync` доходят до OpenCode, но Hermes остаётся нетронутым.

Удаления нет вообще: ни провайдеров, ни моделей. `sync` возвращает удалённые вручную модели, потому что считает сервер источником истины. Чтобы это исправить, нужен не просто `remove`, а `remove` + tombstones + `restore` + проверка default-ссылок и credential store.
