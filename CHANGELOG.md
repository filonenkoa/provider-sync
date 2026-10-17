# Changelog

Format: [semver](https://semver.org). Dates are ISO.

## Unreleased

### Fixed
- `sync`/`add` borrow the OpenCode API key for a Hermes `custom_providers`
  entry from the provider's **config entry** as well as `auth.json`. Since 1.1.1
  that is where `add --key` stores it, but only `list` knew: a Hermes entry with
  `api_key: dummy` was probed without a key and failed with `AUTH 401` while the
  report claimed `key (borrowed from …)`.
- `{env:VAR}` keys (stored by `--key-env`) are resolved from the environment
  when provider-sync probes a server; previously the literal `{env:VAR}` went
  out as the bearer token, so every check failed with `AUTH 401` even when the
  variable was set. An unset variable is now reported as such instead of
  "key missing or invalid".
- `add --key-env` writes `key_env: VAR` into the Hermes entry instead of the
  OpenCode-only `{env:VAR}` string, which Hermes cannot resolve; a live literal
  `api_key` that would shadow the reference is replaced with `dummy`.
- `--dry-run` now means "write nothing" in every command: `sync --apply --dry-run`
  applied the changes anyway, and `set-ctx --dry-run` wrote. It also wins over
  `--apply` on the same line.
- Flag typos can no longer change what a command does: an unknown flag
  (`--targe=hermes`) was silently dropped and the default target written to, and
  `--apply=false` read as "apply" because any non-empty string is truthy. Both
  are refused now, as are an empty or negative `--ctx`/`--output` (`--ctx=`
  silently meant "omit the limit").
- `sync --key K` now also covers the hermes target (documented as single-run,
  never stored, but it was only consulted for opencode providers), and a hermes
  entry whose key lives in OpenCode's database is reported as such — with the
  `--key K` hint — instead of "key missing or invalid".
- `list --target hermes` no longer prints the OpenCode database/keys line,
  which belongs to the opencode target.
- OpenCode 2.x's native config shape (`providers.<id>`) is handled in place:
  `add`/`sync`/`list` read `settings.baseURL`/`settings.apiKey`/`models`
  (limits, capabilities) from it and write updates back into that shape, where
  they used to go to a legacy `provider.<id>` entry that 2.x silently ignores
  when a native entry exists. A new provider in a `providers`-only config is
  written in 2.x shape (package/settings/models); `list` marks such entries
  `(2.x)`. Verified end-to-end against OpenCode 2.0.30: the key arrives as the
  bearer token for native, legacy and mixed configs.
- API keys are written into the entry's own shape only —
  `provider.<id>.options.apiKey` or `providers.<id>.settings.apiKey`. The old
  "write both paths whenever the config has a `providers` section" could plant
  a native entry holding nothing but a key, and OpenCode 2.x serves a native
  entry whole in place of the legacy one — shadowing and breaking the provider
  with "Model unavailable".
- Config discovery honors `$OPENCODE_CONFIG`: OpenCode loads that explicit file
  after the global config, so provider-sync edits the file that wins instead of
  one whose provider entries are overridden.
- A `config.json` setup on a machine with a 2.x database gets a note:
  `config.json` is a 1.x name and OpenCode 2.x reads only `opencode.json` /
  `opencode.jsonc`, so edits there change nothing.
- `loadCfg` no longer injects an empty `provider` section into the parsed
  config — that made a 2.x-only config look like a mixed one and fed the
  key-path bug above.
- Flags that mean nothing for the command are refused like unknown ones
  (`sync --no-hermes` points at `--target opencode`; same for `list --key`,
  `add --apply`, `set-ctx --target`), positional arguments are checked per
  command (`list extra`, `sync oops`), `sync --provider` refuses unknown or
  disabled ids instead of reporting "no providers to check" and rejects
  `--provider` together with `--target hermes`; `add --no-hermes` together with
  `--target hermes` is a conflict. `--help`/`-h`/`--version`/`-v` work on any
  command (`add --help` prints help instead of complaining about a missing
  baseURL).
- Docs: the writer lock lives in the system temp directory (keyed by the config
  directory), not at `~/.config/opencode/.provider-sync.lock` (README and help);
  the README install snippet shows the current version; `--key-env` is
  documented in `help`; the Unsloth 401 message no longer points at `auth.json`
  (keys live in the config entry since 1.1.1); `help` lists `--key`/`--dry-run`
  for `sync` and `set-ctx` and the flag-strictness rule under Safety. README,
  AGENTS.md and `help` also document the 2.x `providers` shape, the
  one-entry-per-provider rule and `$OPENCODE_CONFIG`.

## 1.1.1 — 2026-10-15

### Fixed
- `add --key K` now stores the key in the provider entry of your own config
  (`provider.<id>.options.apiKey`, or `providers.<id>.settings.apiKey` on a 2.x
  config) instead of OpenCode's `auth.json` or database. Verified against the
  OpenCode binary: the key arrives as the bearer token, on 1.x and 2.x, with no
  interactive login — the database route is not scriptable (the TUI prompt needs
  a terminal, `auth login --method key` rejects custom providers, and piping
  stdin hangs).
- `add` re-reads the config after writing and exits non-zero if the key is not
  there, instead of reporting success for a key it never stored.
- `--key-env VAR` stores `{env:VAR}` instead of a literal key, for configs that
  live in version control.
- `add` now says `rejected the supplied key (HTTP 401)` when the server refuses
  the key you passed, instead of asking for `--key` you already gave.
- A readable key in the config or `auth.json` is never hidden by the presence of a
  2.x database; `list` labels where it came from.
- OpenCode 2.x is detected from the filesystem (`OPENCODE_DB`, the documented
  default, or any `*.db` in the data directory) instead of
  `opencode debug paths db`, which itself creates `~/.cache`, `~/.config` and
  `~/.local/share/opencode`. Presence is reported, stored values never are.
- The `keys` line of `add` now names the config path the key is really written to,
  including the 2.x `providers.<id>.settings.apiKey` shape.


## 1.1.0 — 2026-10-03

Second harness (Hermes Agent) is now a first-class target, and the tool reports
exactly what it wrote and what it did not.

### Added
- `add` reaches **every installed harness**: the provider is also created (or
  updated) under `custom_providers` in `~/.hermes/config.yaml`, matched by base
  URL, so re-running updates instead of duplicating. `--no-hermes` /
  `--target opencode|hermes` narrow it.
- `list` is per harness, with the source of each Hermes key (`key`, `key (env)`,
  `key (borrowed from <id>)`) and a clear skip line for an uninstalled one.
- `--target` for `list` and `add`; `--version`; `--model`, `--name`, `--key=VALUE`.
- An exclusive lock (`os.tmpdir()`, keyed by config path) around writing
  commands, with stale-lock takeover; nothing is created in the config tree for
  it.
- Atomic writes with `fsync` of both file and directory; the Hermes config is
  re-read after writing and rolled back from its backup if it no longer parses.
- `--dry-run` for `add`; per-target `written:` report on every writing command.
- CI on Linux, macOS and Windows, Node 18 and 22; 108 tests, zero dependencies.

### Fixed
- `add` no longer creates an OpenCode config on a machine where OpenCode is not
  installed, and creates no directories for it.
- `list` no longer ignores Hermes entirely (it was still OpenCode-only).
- Every install path works again: `npm link` and `~/.local/bin` symlinks used to
  make the CLI exit silently with status 0, because the entry-point check
  compared unresolved paths.
- Model ids that YAML resolves to a number or boolean (`123`, `true`, `yes`,
  `on`, `null`) are quoted, so Hermes and provider-sync agree on the key.
- Hermes entries whose first field is not `name` (alphabetically sorted files)
  parse correctly; flow-style entries are listed and never rewritten.
- Flag values are validated: a missing value no longer becomes a boolean, and
  `--key=value` is accepted instead of being ignored.
- A model id or provider name containing `, }` or `, ]` is no longer corrupted
  when the OpenCode config is rewritten; a fresh config with no `provider`
  section no longer crashes `add`/`set-ctx`.
- `sync` no longer fails with a stack trace when a target's config cannot be
  written; the exit code is non-zero and the failure is named.

### Changed
- Backups are named `.bak-provider-sync-<ms>` (millisecond precision, so rapid
  writes cannot overwrite each other); the previous `.bak-ocp-*` files are still
  recognised and pruned.
- `PS_CONFIG` replaces `OCP_CONFIG` as the config-path override; the old name
  still works.
- The CLI was renamed from `ocp` to `provider-sync`.

## 1.0.0

First tagged release: `add`, `sync`, `set-ctx`, `list` for OpenCode providers
with llama.cpp / LM Studio / Unsloth / OpenAI-compatible detection, ctx and
modality synchronisation, atomic writes with rotating backups.
