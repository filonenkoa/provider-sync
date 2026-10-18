# provider-sync

CLI to keep the model providers of [OpenCode](https://opencode.ai), [Hermes Agent](https://github.com/NousResearch/hermes-agent) and [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (`dsh`) in sync with the servers they point at: which models exist, how large their context window is, what they can accept as input — and, for Hermes, keeps its offline model catalog usable when a server is down.

It edits the config each tool already reads. Nothing is guessed silently: every write reports what changed, what was skipped and why.

> **AI agents:** [AGENTS.md](AGENTS.md) is the short version — how to inspect provider state, add providers and apply a sync from an agent or a skill that wraps this tool.

Zero dependencies · Node ≥ 18 (built-in `fetch`) · Linux, macOS, Windows.

## Install

```sh
git clone https://github.com/filonenkoa/provider-sync.git && cd provider-sync
npm link
```

`npm link` puts the symlink in `$(npm prefix -g)/bin`, which may not be on your `PATH`:

```sh
command -v provider-sync || echo 'export PATH="$(npm prefix -g)/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
provider-sync --version   # 1.2.1
```

Prefer no npm? Symlink it into a directory you already keep bins in:

```sh
mkdir -p ~/.local/bin && ln -s "$PWD/bin/provider-sync.js" ~/.local/bin/provider-sync
```

`command not found` after installing always means "not in PATH", not a broken install. On Fedora/RHEL use `~/.bash_profile`; on Windows, put the npm global prefix's directory on `PATH`. There is nothing to `npm install` — the tool has no dependencies.

## Quick start

```sh
provider-sync list            # what is configured, per harness (read-only)
provider-sync add 3090 http://10.0.0.5:64980/v1 --key <api-key>   # register a provider
provider-sync sync            # status check — writes nothing, this is the safe default
provider-sync sync --apply    # apply the drift it reported
```

`list` on a machine with all three harnesses:

```
opencode  ~/.config/opencode/opencode.jsonc
  3090                 26 models  http://100.64.0.10:64980/v1  key (config)
  local-lmstudio        2 models  http://localhost:1234/v1  no-key
keys      ~/.local/share/opencode/opencode.db  credentials live in OpenCode's database …
hermes  ~/.hermes/config.yaml (providers)
  MM box               26 models  http://100.64.0.10:64980/v1  key (borrowed from 3090)
dsh       ~/.dsh/settings.yaml (pre-0.2 document)
  ivan3090             26 models  http://100.64.0.10:64980/v1  key (stored)
  openrouter           14 models  -  key (stored)
  note: settings.yaml is the pre-0.2 document — dsh imports it into its profile at the next boot
```

`sync` reports drift per provider and stops there unless you pass `--apply`:

```
3090 (llamacpp, http://100.64.0.10:64980/v1): 27 on server, 26 in config
  + IY/Qwen3.8-27B-UD-Q6_K_M-262Kctx
  - IY/Qwen3.8-27B-stale (no longer on server)
  ~ ctx IY/Qwen3.8-27B-UD-Q4_K_M-262Kctx: 65536 -> 262144
alex4090: OFFLINE (timeout) — skipped
3 change(s) pending — re-run with --apply to write
```

Offline or auth-failing servers are reported and skipped; the rest of the run is unaffected.

## Commands

| Command | What it does |
| --- | --- |
| `list` | Providers per harness: id/name, model count, base URL, key status. Read-only. |
| `add <id> <baseURL>` | Register or update a provider in every **installed** harness. |
| `sync` | Report (or, with `--apply`, write) the drift between servers and config. |
| `set-ctx <provider>` | Interactively re-ask the context window of models the server reports none for. Needs a TTY. |
| `help`, `--help`, `--version` | The full in-tool documentation / version. |

### `provider-sync list [--target all\|opencode\|hermes\|dsh] [--profile NAME]`

Per provider: id, model count, base URL and where its key comes from — for Hermes whether it is a literal, a `~/.hermes/.env` reference or one borrowed from an OpenCode provider pointing at the same server; for dsh whether it is the launch environment, the credential store or `~/.dsh/.env`. Entries in OpenCode's 2.x `providers` shape are marked `(2.x)`.

A harness that is not installed is reported as `not found — skipped` instead of failing, so Hermes-only, OpenCode-only and dsh-only machines all work. Notes tell you which surface dsh is reading and which Hermes surface is in use.

### `provider-sync add <id> <baseURL> [options]`

Registers or updates one provider everywhere. Upsert: models missing on the server are removed, new ones added, server-reported context and modalities applied, configured values kept when the server reports nothing. Re-running against a moved server re-points it instead of duplicating (entries are matched by base URL, then by id).

| Option | Effect |
| --- | --- |
| `--name N` | Display name (default: the existing one, else `<id>`). |
| `--key K` | API key. Stored per harness (see [Keys](#keys)). |
| `--key-env VAR` | Store a reference instead of the secret — `{env:VAR}` in OpenCode, `key_env:` in Hermes, `apiKeyEnv:` in dsh. Resolved from the environment while probing; nothing secret is written. |
| `--username U --password P` | Unsloth UI login: provider-sync signs in and creates a persistent API key named after `<id>`. Both flags are required together, and only an Unsloth UI server accepts them; anything unused is reported. |
| `--model M` | Model written into the Hermes entry's `model:` field (default: the first the server reports). |
| `--ctx N` | Context for models whose server reports none (`0` = write no limit). Without it, provider-sync asks in a terminal and shows a guess with `--dry-run`. |
| `--output N` | Max output tokens written into new limits (default `65536`). |
| `--target T` | `all` (default) \| `opencode` \| `hermes` \| `dsh` — only these are written. |
| `--profile NAME` | dsh profile whose patch is edited (default `web`). |
| `--no-hermes` | Shortcut for `--target opencode`. |
| `--dry-run` | Report the plan, create no API key, write nothing. |

A harness that is not installed is **skipped, not created** — except when you ask for it explicitly: `--target opencode` creates the OpenCode config if it is missing, `--target dsh` writes a profile-agnostic `~/.dsh/settings.yaml` when there is no dsh home yet.

### `provider-sync sync [--apply] [--target …] [--provider ID] [--profile NAME]`

| Option | Effect |
| --- | --- |
| `--apply` | Write what was reported. Without it nothing is written. |
| `--target T` | Which harness(es) to check: `all` (default) \| `opencode` \| `hermes` \| `dsh`. |
| `--provider ID` | One OpenCode provider. An unknown or `disabled_providers` id is refused, not silently reported as "nothing to do". |
| `--profile NAME` | dsh profile to read (default `web`, else the only one there is). |
| `--ctx N`, `--output N` | As in `add` — context for models the server reports none for. |
| `--key K` | A key to use **for this run only** (e.g. one that lives in OpenCode's database and cannot be read). Never stored. |
| `--dry-run` | Report only. It wins over `--apply` on the same line. |

### `provider-sync set-ctx <provider> [--output N] [--key K] [--dry-run]`

Asks, per model whose server reports no context window: **Enter** = best known value (native trained window from server metadata when available, else a heuristic on the model id), **a number** = use it, **k** = keep the current value, **0** = write no limit. Models the server no longer lists are skipped.

### Flags it refuses

A flag that parses but means nothing for the command it sits on is an error, not a silent no-op: `sync --no-hermes` (suggests `--target opencode`), `list --key`, `add --apply`, `set-ctx --target`. So are typos (`--targe=hermes`), a value on a boolean flag (`--apply=false`) and a wrong number of positional arguments. `--help`/`-h` and `--version`/`-v` work on any command.

Release notes: [CHANGELOG.md](CHANGELOG.md). The full reference lives in `provider-sync help`.

## How it works

**Server detection.** Unsloth UI (root `/openapi.json` says so) → LM Studio (`/api/v0/models`; embedding models are skipped) → llama.cpp (`status.args` / `preset` / `architecture` in `/v1/models`) → any OpenAI-compatible server (`/v1/models`). For dsh routes the `api:` field decides the listing endpoint, as dsh itself does (see [DeepSeek Harness](#deepseek-harness-dsh)).

**Context window, first match wins:**

1. the server — llama.cpp preset `--ctx-size` (else the allocated `n_ctx`), LM Studio loaded (else max) context, Unsloth UI `context_length`;
2. `--ctx N` (`0` = no limit);
3. an interactive prompt in a terminal, with the best guess shown (Enter accepts it);
4. omitted with a note when writing non-interactively without `--ctx` — in report mode a guess is displayed instead, so you can see what `--apply` would do.

Configured values are never clobbered — re-ask them with `set-ctx`. Guesses are only ever hints: **Hermes and dsh receive server-reported context lengths only**, so their offline catalogs never contain a fabricated window.

**Modalities.** llama.cpp's `architecture.input_modalities` is ground truth and corrects wrong declarations; LM Studio reports VLM models as text+image; otherwise a heuristic on the model id (`qwen3.8*` → text+image+video, `qwen*`/`gemma*` → text+image, else text).

**New models in OpenCode** additionally get: attachment support when input is more than text, `tool_call` disabled for `*base*` model ids, `reasoning` enabled for thinking-style ids (`qwen3.5+`, `qwen4`, `muse-glimmer`, `*thinking*`).

## Keys

Each harness keeps credentials where its own tool keeps them; provider-sync never writes OpenCode's own stores, and never prints a stored secret.

| Harness | `add --key K` writes | Resolution order when probing |
| --- | --- | --- |
| OpenCode | the provider entry itself — `provider.<id>.options.apiKey` (1.x shape) or `providers.<id>.settings.apiKey` (2.x shape) — which OpenCode sends as the bearer token | entry value → `auth.json` (1.x) / database (2.x, presence only) → `--key K` for the run |
| Hermes | `api_key:` in the entry (or `key_env: VAR` with `--key-env`) | entry literal → `${VAR}` / `key_env` from `~/.hermes/.env` → the OpenCode key of a provider on the same server URL → `--key K` |
| dsh | `~/.dsh/.credentials.yaml` under the entry's reference — a new provider gets `<ID>_API_KEY`, dsh's own convention — mode `600`, because dsh refuses a store others can read | `apiKeyEnv` in the launch environment → that reference in the credential store → `~/.dsh/.env`; a route with **no** `apiKeyEnv` authenticates from its own record `llm-pi-ai/<route>` in the store (what a dsh sign-in writes), and provider-sync neither invents a reference over it nor prints it |

A keyless OpenAI-compatible dsh route gets the placeholder `dummy`, because such a request fails with `MISSING_CREDENTIAL` otherwise.

## Files touched

| File | What provider-sync does |
| --- | --- |
| `$OPENCODE_CONFIG`, else the first existing of `opencode.jsonc` / `opencode.json` / `config.json` in `$OPENCODE_CONFIG_DIR` or `~/.config/opencode` (override: `PS_CONFIG`) | provider entries: models, limits, modalities, and the API key. `jsonc` wins over `json`; `config.json` is a 1.x name that 2.x ignores (provider-sync says so when a 2.x database is present). Skipped if OpenCode is not installed. |
| `~/.local/share/opencode/auth.json`, `~/.local/share/opencode/opencode.db` | OpenCode's own credential stores. **Read-only for provider-sync**: presence is reported, a value is never printed, nothing is ever written. |
| `~/.hermes/config.yaml` — the `providers:` mapping, or the legacy `custom_providers:` list when that is what the file carries (Hermes' config v12 migration moves the list into the mapping and deletes it; a file with neither gets `providers:`) | entries created/updated by `add`; their `models:` maps (the offline fallback catalog) refreshed by `sync`. Surgical line edits — comments and every other field survive byte for byte. Skipped if Hermes is not installed. |
| `~/.hermes/.env` | key source for Hermes providers. Read-only. |
| `~/.dsh/settings.yaml` (the dsh home is `$DSH_HOME`, tilde expanded, or `~/.dsh`) | the `llm-pi-ai` providers block of the pre-0.2 document. dsh imports this file into the active profile at its next boot and renames it `settings.yaml.imported`, so provider-sync writes here only while it exists (a re-created file is imported again). |
| `~/.dsh/profiles/<name>/cordis.patch.yml` | the live provider state: `config.providers` of the `- id: llm-pi-ai` patch item. Default profile `web`; `--profile NAME` picks another; with no profile yet, `add` falls back to `settings.yaml`. Only the providers subtree is regenerated. |
| `~/.dsh/.credentials.yaml` | dsh's credential store — written by `add --key`/`--key-env` (see [Keys](#keys)), mode `600`, values never printed. |

## Per-harness behaviour

### OpenCode

Each provider is kept in **exactly one entry shape** — the one its entry already uses. A config may carry both the legacy `provider.<id>` shape and the 2.x native `providers.<id>` shape; on 2.x a native entry *replaces* a legacy one wholesale, so a second, partial entry for the same id would shadow and break the real provider. provider-sync therefore updates a `providers.<id>` entry in place (`package` / `settings` / `models`) and leaves a legacy one legacy (2.x migrates it at load). A brand-new provider follows the file's dialect: 2.x shape only in a config that has `providers` and no `provider`, legacy everywhere else.

After every write the config is checked against [OpenCode's own schema](https://opencode.ai/config.json) — unknown model keys, bad modalities and incomplete limits are reported; valid entries OpenCode knows about (`cost`, `variants`, `headers`, …) are not.

`disabled_providers` entries are skipped by `sync`.

### Hermes

Only `context_length` is written per model — it is the only per-model field Hermes reads from config — and other fields of an entry (`discover_models`, `capabilities`, `extra_body`, …) are left exactly as written. The top-level `model:` block is never touched.

An entry written in **flow style** (`- {name: x, base_url: y}`, or a one-line entry in the mapping) is listed but never rewritten: the surgical edits work on indented lines and cannot patch inside braces, so `sync` and `add` skip it and say so. The same holds for a comment inside an entry and for other shapes provider-sync cannot rewrite without guessing — each is reported as `skipped — <reason>`.

### DeepSeek Harness (`dsh`)

**Where state lives.** The `llm-pi-ai` providers block of `~/.dsh/settings.yaml` while that file exists (the pre-0.2 document, which dsh imports at its next boot), otherwise the `config.providers` block of the `- id: llm-pi-ai` item in `~/.dsh/profiles/<profile>/cordis.patch.yml`. Only that subtree is regenerated — everything else in the file survives byte for byte.

**Probing follows the wire protocol.** `api: openai-completions` / `openai-responses` list at `{baseURL}/models` with a bearer token (llama.cpp and LM Studio keep their richer listings: allocated context, input modalities); `api: anthropic-messages` lists at `{root}/v1/models` with `x-api-key` and an `anthropic-version` header. `add` detects an Anthropic-compatible endpoint and writes `api: anthropic-messages` for that route. A route naming a protocol this build cannot serve is reported, never probed.

**Models.** Model lists are server-authoritative: new models added, gone models removed, server-reported `contextWindow` pinned (compared against the effective value, so dsh's default of 262144 counts as "unset"). Entries dsh owns — `api`, `displayName`, timeouts, `compat` — are left alone. A model the server reports as taking images gets `input: [text, image]`, because dsh's model schema has exactly those two request modalities and text-only is its default; modalities dsh cannot express are left out rather than written, since an out-of-schema input list would take that model out of every picker.

**Refusals** (reported as `skipped — <reason>`, nothing written): a providers block containing comments, anchors, aliases, tags (`!!js`), block scalars, flow mappings or tab indentation; an `insert:` list or a second `llm-pi-ai` item making the live one ambiguous; a home-level `~/.dsh/cordis.patch.yml` that also targets `llm-pi-ai` (it wins over the profile's); and a route that tunes its catalog with `modelOverrides` and lists no models — dsh rejects a `models` list beside `modelOverrides`, and that rejection takes the route out of every picker.

Every dsh write is re-read afterwards and compared provider-by-provider; a mismatch rolls the file back from its backup.

## What a write reports

```
written:
  opencode  ~/.config/opencode/opencode.jsonc  provider "3090" (26 models)
  keys      ~/.config/opencode/opencode.jsonc  api key for "3090" in … provider.3090.options.apiKey
  hermes    ~/.hermes/config.yaml  providers "MM box" updated (26 models, model: IY/Qwen…)
  dsh       ~/.dsh/profiles/web/cordis.patch.yml  provider "3090" updated (26 models, key ref _3090_API_KEY)
  dsh-keys  ~/.dsh/.credentials.yaml  key "_3090_API_KEY" stored
```

Every line says which file, what changed, and — when something was skipped — which of the two reasons it was (`not installed`, `not selected`, or the refusal itself). A silent skip is never the answer.

## Safety

- Every write is atomic (temp file + `fsync` + `rename`) and preceded by a `.bak-provider-sync-*` backup; the last 3 per file are kept.
- The Hermes config and the dsh configs are re-read after writing and rolled back from the backup if they no longer parse or say what was intended; the OpenCode config is validated against its schema.
- `~/.dsh/.credentials.yaml` is written owner-only (`600`) — dsh refuses to load a store others can read.
- Secrets are never printed; only where a key came from is.
- Writing commands (`add`, `sync --apply`, `set-ctx`) take an exclusive lock in the system temp directory keyed by the config directory, so two runs cannot interleave. Read-only commands never take it.
- `--dry-run` never writes, in `add`, `sync` and `set-ctx` alike, and wins over `--apply` on the same line.

## Exit codes

`0` on success. Non-zero, with an explanation on stderr, when something you asked for did not happen: `add` on a server that is unreachable or rejects the key, a flag that means nothing for the command, a config that cannot be parsed, a write that could not be verified, a refused layout, or a model entry OpenCode's schema rejects. A run that merely *reports* problems — a server down during `sync`, an offline entry — is still a successful run: nothing was asked of it, so it exits `0`.

## Known limits

- OpenAI-shaped probes: OpenCode and Hermes entries are always written as OpenAI-compatible providers, so an Anthropic-only endpoint gets a working dsh route (`api: anthropic-messages`) but not a working OpenCode/Hermes one — those need the vendor's own provider package.
- dsh `maxTokens` is never written; dsh's default (32768) applies.
- Hermes offline catalogs carry context lengths only, because that is the only per-model field Hermes reads from configuration.
- Only llama.cpp, LM Studio, Unsloth UI and OpenAI-compatible servers are detected; anything else is registered by base URL and refreshed from `/v1/models`.

## Troubleshooting

| Symptom | What it means |
| --- | --- |
| `command not found` after install | `PATH` does not contain `$(npm prefix -g)/bin`. |
| `no <file>` / `not found — skipped` | That harness is not installed here; the other targets still ran. |
| `OFFLINE (…) — skipped` | The server is unreachable. Nothing was written for it. |
| `AUTH 401 — …` | The key for that server is missing, unreadable or rejected. The message says which. |
| `skipped — <reason>` | provider-sync will not rewrite that shape; the reason names what it found. Fix it by hand — do not force it. |
| `VALIDATION ERRORS` after a write | The config OpenCode would read is invalid; the exit code is non-zero and the backup is kept. |
| An edit you made disappears | A harness rewrote its own config after you edited it by hand. provider-sync never writes OpenCode's credential stores, and it handles both Hermes surfaces, so it can be re-applied on top. |

## Development

```sh
npm test        # 226 tests, no network access beyond localhost fixtures
```

Pure ESM, zero dependencies, tests run in-process and through the real CLI with a temporary `$HOME`. CI covers Node 18 and 22 on Linux, macOS and Windows.

## License

MIT