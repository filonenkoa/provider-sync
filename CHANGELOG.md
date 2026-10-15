# Changelog

Format: [semver](https://semver.org). Dates are ISO.

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
