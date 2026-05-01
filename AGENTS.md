# AGENTS.md — Pi Extensions Architecture & Implementation Guide

> This document provides a comprehensive reference for the architecture, design decisions, and implementation details of all extensions in this repository. It is intended for contributors, maintainers, and anyone who wants to understand or extend these extensions.

## Table of Contents

1. [Project Overview](#project-overview)
2. [Extension Architecture](#extension-architecture)
3. [Permission Extension](#permission-extension)
4. [Token Rate Extension](#token-rate-extension)
5. [Shared Conventions](#shared-conventions)
6. [Testing Strategy](#testing-strategy)
7. [Contributing](#contributing)

---

## Project Overview

This repository contains personal extensions for [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent), a terminal-based AI coding assistant. The extensions are:

| Extension | Purpose | Key Files |
|-----------|---------|-----------|
| **Permission** | Layered security — classifies and gates bash commands and file writes by permission level | `permission.ts`, `permission-core.ts` |
| **Token Rate** | Observability — shows real-time token throughput and stream status in the UI footer | `token-rate.ts` |

Both extensions follow the pi extension API contract and can be loaded individually or together.

---

## Extension Architecture

### Pi Extension API Contract

Every pi extension is a TypeScript module that exports a default function:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Register commands, hook events, etc.
}
```

The `ExtensionAPI` provides:

| Method / Property | Purpose |
|-------------------|---------|
| `pi.registerCommand(name, { description, handler })` | Register a slash command (e.g., `/permission`) |
| `pi.on(event, handler)` | Subscribe to lifecycle events |
| `ctx.ui.setStatus(key, text?)` | Set / clear footer status line entries |
| `ctx.ui.notify(message, type)` | Show in-app notification (`"info"`, `"warning"`, `"error"`) |
| `ctx.ui.select(prompt, options)` | Show interactive selector, returns chosen option |
| `ctx.hasUI` | Whether the session has an interactive UI |

### Extension Loading

Extensions are discovered via `package.json`:

```json
{
  "pi": {
    "extensions": ["./permission/permission.ts", "./token-rate/token-rate.ts"]
  }
}
```

Pi loads extensions from:
1. `~/.pi/agent/extensions/` — global user extensions
2. `.pi/extensions/` — project-local extensions
3. npm packages with the `pi-package` keyword installed via `pi install`

### Event Lifecycle

```
session_start → [turn_start → message_update* → tool_call* → turn_end]* → session_shutdown
                    ↑                                                          │
                    └────────────── session_switch ──────────────────────────┘
```

---

## Permission Extension

### Design Philosophy

The core principle: **building/installing is MEDIUM, running code is HIGH**.

This reflects the insight that most development operations (installing packages, running tests, building) are reversible or low-risk, while running arbitrary code, pushing to remotes, or modifying system state is not.

### Architecture

The extension is split into two modules:

#### `permission-core.ts` — Pure Functions (No Side Effects)

Contains all classification and configuration logic with zero dependencies on the pi runtime:

| Component | Responsibility |
|-----------|---------------|
| `classifyCommand(command, config?)` | Classify a shell command → `{ level, dangerous }` |
| `parseCommand(command)` | Parse shell commands using `shell-quote`, split by operators |
| `isMinimalLevel(tokens)` | Check if command is read-only |
| `isMediumLevel(tokens)` | Check if command is a build/install/test operation |
| `isHighLevel(tokens)` | Check if command runs code / is irreversible |
| `isDangerousCommand(tokens)` | Detect sudo, rm -rf, chmod 777, dd, etc. |
| `detectShellTricks(command)` | Detect `$(cmd)`, backticks, process substitution |
| `loadPermissionConfig()` / `savePermissionConfig()` | Read/write `~/.pi/agent/settings.json` |
| `applyPrefixMappings(command, mappings)` | Normalize version-manager prefixed commands |
| `checkOverrides(command, overrides)` | Match glob patterns against command |
| `validateConfig(config)` | Sanitize and validate user configuration |

#### `permission.ts` — Extension Entry Point & State Management

Handles the pi integration layer:

| Component | Responsibility |
|-----------|---------------|
| `createInitialState()` | Create fresh `PermissionState` |
| `handleSessionStart()` | Load global settings, set status bar |
| `handleBashToolCall()` | Intercept `bash` tool calls, classify, block or prompt |
| `handleWriteToolCall()` | Intercept `write`/`edit` tool calls, require at least `low` |
| `handlePermissionCommand()` | Handle `/permission` slash command |
| `handlePermissionModeCommand()` | Handle `/permission-mode` slash command |
| `handleConfigSubcommand()` | Handle `/permission config show|reset` |
| `cyclePermissionLevel()` | Cycle permission level via keyboard shortcut |
| `playPermissionSound()` | Audio notification on permission prompts |

### Permission Levels

```
minimal (0) → low (1) → medium (2) → high (3) → bypassed (4)
```

| Level | Icon | Label | Index | Allows | Blocks |
|-------|------|-------|-------|--------|--------|
| **minimal** | 🟢 | Read Only | 0 | Read-only: `cat`, `ls`, `grep`, `git status/log/diff`, `npm list` | File writes, command execution, any side effects |
| **low** | 🟡 | File Write | 1 | + `write`/`edit` tool calls, file redirections (`>`, `>>`) | Package installs, git commits, builds |
| **medium** | 🟠 | Dev Ops | 2 | + `npm install`, `git commit/pull`, build tools, linters, test runners | `git push`, `sudo`, running arbitrary code, deployments |
| **high** | 🔴 | Full Access | 3 | + `git push`, `curl/wget`, `ssh`, `docker push`, `kubectl` | Dangerous commands (always prompt) |
| **bypassed** | ⚫ | No Limit | 4 | All operations | Nothing (use with extreme caution) |

Footer status bar shows: `🟢 Read Only`, `🟡 File Write`, `🟠 Dev Ops`, `🔴 Full Access`, `⚫ No Limit`

**Dangerous commands** always prompt regardless of level: `sudo`, `rm -rf`, `chmod 777`, `dd of=/dev/*`, `mkfs`, `shutdown`, `reboot`.

### Permission Modes

| Mode | Behavior |
|------|----------|
| `ask` | When a command exceeds the current level, prompt the user (default) |
| `block` | When a command exceeds the current level, block silently |

In non-interactive mode (print/RPC), `block` behavior is always used regardless of the setting.

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `alt+m` | Cycle permission level forward (Read Only → File Write → Dev Ops → Full Access → No Limit → Read Only) |
| `alt+shift+m` | Cycle permission level backward |

Keyboard cycling is always **session-only** — it does not modify the global `permissionLevel` setting. To persist a level change globally, use the `/permission` command.

### Command Classification Pipeline

```
Input: "fvm flutter build"
  │
  ├─ 1. Apply prefix mappings
  │     "fvm flutter build" → "flutter build"
  │
  ├─ 2. Parse with shell-quote
  │     ["flutter", "build"] → segments, operators
  │
  ├─ 3. Detect shell tricks
  │     $(cmd), `cmd`, <(cmd), >(cmd), ${VAR:-$(cmd)}
  │     → If detected: return { level: "high", dangerous: false }
  │
  ├─ 4. Check overrides (glob patterns)
  │     Match against normalized command string
  │     Priority: dangerous > high > medium > low > minimal
  │
  ├─ 5. Check output redirections
  │     > file, >> file → requires at least "low"
  │     > /dev/null → safe (minimal)
  │
  ├─ 6. Classify each pipeline segment
  │     For each segment:
  │       a. Check shell execution commands (eval, exec, source, env, etc.) → HIGH
  │       b. Check dangerous commands (sudo, rm -rf, etc.) → HIGH + dangerous
  │       c. Check minimal level (read-only commands)
  │       d. Check medium level (build/install/test)
  │       e. Check high level (code execution, remote ops)
  │       f. Default → HIGH (unknown commands are high)
  │
  ├─ 7. Check pipe-to-shell patterns
  │     ... | bash/sh/zsh/node/python → HIGH
  │
  └─ 8. Return highest level across all segments
        { level: "medium", dangerous: false }
```

### Detailed Command Classification Rules

#### Minimal (Read-Only) Commands

**File reading:** `cat`, `less`, `more`, `head`, `tail`, `bat`, `tac`

**Directory:** `ls`, `tree`, `pwd`, `dir`, `vdir`, `cd`, `pushd`, `popd`, `dirs`

**Search:** `grep`, `egrep`, `fgrep`, `rg`, `ag`, `ack`, `fd`, `locate`, `which`, `whereis`

**Info:** `echo`, `printf`, `whoami`, `id`, `date`, `cal`, `uname`, `hostname`, `uptime`, `type`, `file`, `stat`, `wc`, `du`, `df`, `free`, `ps`, `top`, `htop`, `pgrep`, `sleep`

**Man/Help:** `man`, `help`, `info`

**Pipeline utilities:** `sort`, `uniq`, `cut`, `awk`, `sed`, `tr`, `column`, `paste`, `join`, `comm`, `diff`, `cmp`, `patch`

**Shell test:** `test`, `[`, `[[`, `true`, `false`

**Conditional write commands (safe when no write flag):**
- `find` — minimal UNLESS `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete` flags present
- `xargs` — minimal IF the executed command is in `MINIMAL_COMMANDS` (e.g., `xargs cat`), otherwise HIGH
- `tee` — minimal IF writing only to `/dev/null` or no file arguments

**Git read operations:** `status`, `log`, `diff`, `show`, `branch` (listing), `remote` (listing), `tag` (listing), `ls-files`, `ls-tree`, `cat-file`, `rev-parse`, `describe`, `shortlog`, `blame`, `annotate`, `whatchanged`, `reflog`, `fetch`

**Package info:** `npm list/ls/info/view/outdated/audit`, `yarn list/info/why/outdated/audit`, `pnpm list/ls/outdated/audit/why`, `pip list/show/freeze/check`, `cargo tree/metadata/search/info`, `go list/version/env`

**Version checks:** Any command with `--version`, `-v`, or `-V` flag

#### Medium (Build/Install/Test) Commands

**Node.js ecosystem:**
- `npm install/ci/add/remove/uninstall/update/rebuild/dedupe/prune/link/pack/test/build`
- `yarn install/add/remove/upgrade/import/link/pack/test/build`
- `pnpm install/add/remove/update/link/pack/test/build`
- `bun install/add/remove/update/link/test/build`
- `npm run <safe-script>` — only `build*`, `test*`, `lint*`, `format*`, `check*`, `type*` prefixes
- ⚠️ `npx`/`bunx`/`pnpx` → HIGH (run arbitrary packages)

**Python:**
- `pip install`, `pip3 install`, `pipenv install/update/sync/lock/uninstall`
- `poetry install/add/remove/update/lock/build`, `pytest`, `uv pip/sync/lock`
- ⚠️ `python`/`python3` → HIGH (run arbitrary code)

**Rust:**
- `cargo install/add/remove/fetch/update/build/test/check/clippy/fmt/doc/bench/clean`
- `rustc`, `rustfmt`
- ⚠️ `cargo run` → HIGH

**Go:**
- `go get/mod/build/test/generate/fmt/vet/clean/install`
- ⚠️ `go run` → HIGH

**Ruby:** `gem install`, `bundle install/update/add/remove/binstubs`, `rspec`
**CocoaPods:** `pod install/update/repo`
**PHP:** `composer install/require/remove/update/dump-autoload`, `phpunit`
**Java:** `mvn install/compile/test/package/clean/dependency/verify`, `gradle build/test/clean/assemble/dependencies/check`
**.NET:** `dotnet restore/add/build/test/clean/publish/pack/new`, `nuget install`
**Dart/Flutter:** `dart pub/compile/test/analyze/format/fix`, `flutter pub/build/test/analyze/clean/create/doctor`
**Swift:** `swift package/build/test`, `swiftc`
**Elixir:** `mix deps/compile/test/ecto/phx.gen`
**Haskell:** `cabal install/build/test/update`, `stack install/build/test/setup`, `ghc`
**Others:** `nimble install`, `zig build/test/fetch`, `cmake`, `make`, `ninja`, `meson`

**Linters/Formatters (all MEDIUM):**
ESLint, Prettier, Black, Flake8, Pylint, Ruff, Mypy, Pyright, TSC, Rubocop, SwiftLint, Ktlint, Clang-Tidy, ShellCheck, Checkov, TFLint, Buf, SQLFluff, YAMLLint, MarkdownLint, CommitLint, and many more.

**Test runners:** `jest`, `mocha`, `vitest`, `pytest`

**File operations:** `mkdir`, `touch`, `cp`, `mv`, `ln`

**Git local operations:** `add`, `commit`, `pull`, `checkout`, `switch`, `branch` (create), `merge`, `rebase`, `cherry-pick`, `stash`, `revert`, `tag` (create), `rm`, `mv`, `reset` (without `--hard`), `clone`

**Database (local dev):** `prisma generate/migrate/db/studio`

#### High (Code Execution / Irreversible) Commands

**Running code:** `python script.py`, `node app.js`, `cargo run`, `go run .`, `ruby script.rb`, `php script.php`

**Unsafe npm scripts:** `npm run dev/start/serve/watch/preview`

**Package executors:** `npx`, `bunx`, `pnpx`

**Git irreversible:** `git push`, `git reset --hard`, `git clean`, `git restore`

**Network:** `curl`, `wget`

**Deployment:** `docker push/login`, `kubectl`, `helm`, `terraform`, `pulumi`, `ansible`

**Remote access:** `ssh`, `scp`, `rsync`

**Shell execution:** `eval`, `exec`, `source`, `.`, `env` (can execute commands), `command`, `builtin`, `time`, `nice`, `nohup`, `timeout`, `watch`, `strace`

**Databases:** `psql`, `mysql`, `sqlite3`, `mongosh`, `redis-cli`

**Unknown commands** default to HIGH.

#### Dangerous Commands (Always Prompt)

| Command | Detection Rule |
|---------|---------------|
| `sudo <anything>` | Always dangerous |
| `rm -rf` / `rm -r -f` / `rm --recursive --force` | Both `-r` and `-f` must be present |
| `chmod 777` / `chmod a+rwx` | Exact permission pattern match |
| `dd of=/dev/...` | Writing to device files |
| `mkfs*`, `fdisk`, `parted`, `format` | Disk operations |
| `shutdown`, `reboot`, `halt`, `poweroff`, `init` | System power commands |
| Fork bomb `:(){ :|:& };:` | Pattern match in joined tokens |

### Shell Trick Detection

Commands containing these patterns automatically require HIGH permission because we cannot reliably classify the embedded commands:

| Pattern | Example | Risk |
|---------|---------|------|
| Command substitution | `$(whoami)`, `$(rm -rf /)` | Can execute arbitrary code |
| Backtick substitution | `` `whoami` `` | Can execute arbitrary code |
| Process substitution (input) | `<(ls)` | Executes commands in subshell |
| Process substitution (output) | `>(cat)` | Executes commands in subshell |
| Nested command in `${}` | `${VAR:-$(cmd)}`, `${VAR:-\`cmd\`}` | Command substitution hidden in parameter expansion |

**Safe patterns** (correctly NOT detected as shell tricks):
- Simple variable expansion: `$PATH`, `${HOME}`
- Parameter expansion: `${#VAR}`, `${VAR:0:5}`, `${VAR/pat/repl}`, `${VAR:-default}`
- Arithmetic expansion: `$((1 + 2))` (excluded via negative lookahead `$(?!\()`)
- ANSI-C quoting: `$'hello\nworld'`
- Locale translation: `$"hello"`
- Glob patterns: `*.txt`, `**/*.ts`

### Override & Prefix Mapping System

#### Override Patterns

Glob patterns matched against the **normalized** full command string:

```
*  → matches any characters (including none)
?  → matches exactly one character
```

Patterns are case-insensitive. Override priority: `dangerous` > `high` > `medium` > `low` > `minimal`.

Example configuration in `~/.pi/agent/settings.json`:

```json
{
  "permissionConfig": {
    "overrides": {
      "minimal": ["tmux list-*", "tmux show-*"],
      "medium": ["tmux attach*", "tmux new*"],
      "high": ["rm -rf *"],
      "dangerous": ["dd if=* of=/dev/*"]
    }
  }
}
```

**Security note:** Overrides can bypass built-in classification by design. Use with caution in trusted environments.

#### Prefix Mappings

Normalize version-manager prefixed commands before classification:

```json
{
  "permissionConfig": {
    "prefixMappings": [
      { "from": "fvm flutter", "to": "flutter" },
      { "from": "nvm exec", "to": "" },
      { "from": "rbenv exec", "to": "" },
      { "from": "pyenv exec", "to": "" }
    ]
  }
}
```

Processing order: prefix mapping → shell trick detection → override check → built-in classification.

#### Configuration Validation & Caching

- **Validation:** `validateConfig()` sanitizes user input — filters invalid entries, limits pattern counts (100/level, 50 prefix mappings), rejects pathological glob patterns (>4 consecutive `*`)
- **Caching:** Config and compiled regex patterns are cached with a 5-second TTL
- **Regex cache:** Up to 500 compiled patterns with FIFO eviction to prevent memory exhaustion
- **ReDoS protection:** Patterns with 5+ consecutive `*` are rejected; regex special chars are escaped

### Interactive vs Non-Interactive Behavior

| Scenario | Level Exceeded | Dangerous Command |
|----------|---------------|-------------------|
| Interactive + `ask` mode | Prompt: Allow once / Allow all / Cancel | Prompt: Allow once / Cancel |
| Interactive + `block` mode | Block with reason | Block with reason |
| Non-interactive (print/RPC) | Block with reason + re-run hint | Block with reason + re-run hint |

Re-run hints provide the exact `PI_PERMISSION_LEVEL` needed:

```
Blocked by permission (minimal). Command: npm install lodash
Allowed at this level: 🟢 Read Only — cat, ls, grep, git status/diff/log, npm list, version checks
User can re-run with: PI_PERMISSION_LEVEL=medium pi -p "..."
```

### Settings Persistence

Global settings are stored in `~/.pi/agent/settings.json`:

```json
{
  "permissionLevel": "medium",
  "permissionMode": "ask",
  "permissionConfig": {
    "overrides": { ... },
    "prefixMappings": [ ... ]
  }
}
```

Writes use atomic rename (`write tmp → rename`) on POSIX systems for crash safety.

### Sound Notification

When a permission prompt appears, a sound is played:
- **macOS:** `afplay /System/Library/Sounds/Funk.aiff`
- **Other platforms:** Terminal bell (`\x07`)

### xargs Smart Classification

The `xargs` command is classified intelligently based on what it executes:

| Command | Level | Reason |
|---------|-------|--------|
| `xargs cat` | minimal | `cat` is read-only |
| `xargs grep pattern` | minimal | `grep` is read-only |
| `xargs` (no command) | minimal | Defaults to `/bin/echo` |
| `xargs rm` | high | `rm` is not in MINIMAL_COMMANDS |
| `xargs node` | high | `node` runs code |
| `xargs cat > output.txt` | low | Output redirection to file |

The parser handles all xargs option variants: `-I {}`, `-I{}`, `-0 -n 1 -P 4`, `--null`, `--max-args=5`, etc.

### Redirection Handling

| Redirection | Level | Reason |
|-------------|-------|--------|
| `> /dev/null` | minimal | Safe target |
| `2>/dev/null` | minimal | Stderr suppression |
| `2>&1` | minimal | FD duplication |
| `> file.txt` | low | Writes to file |
| `>> file.txt` | low | Appends to file |
| `&> file.txt` | low | Redirects stdout+stderr to file |
| `cat < input.txt` | minimal | Input redirection is read-only |

---

## Token Rate Extension

### Architecture

The entire extension is a single file (`token-rate.ts`) with no external dependencies beyond the pi API types.

### State Variables

| Variable | Type | Purpose |
|----------|------|---------|
| `totalOutputTokens` | `number` | Cumulative output token count across turns |
| `totalSeconds` | `number` | Cumulative streaming seconds across turns |
| `turnStartMs` | `number \| null` | Timestamp when current turn started |
| `turnStreamEndMs` | `number \| null` | Timestamp when last token was received (before tool call) |
| `streamState` | `StreamState` | Current stream activity state |
| `lastTokenMs` | `number \| null` | Timestamp of most recent token delta |
| `stallCheckInterval` | `Interval \| null` | Timer handle for stall detection |

### TPS Calculation Detail

```
For each completed turn:
  1. endMs = turnStreamEndMs ?? event.timestamp ?? Date.now()
  2. startMs = turnStartMs ?? endMs
  3. elapsedSeconds = max(0.001, (endMs - startMs) / 1000)
  4. outputTokens = message.usage.output ?? 0
  5. If outputTokens > 0:
       totalOutputTokens += outputTokens
       totalSeconds += elapsedSeconds
  6. TPS = totalOutputTokens / totalSeconds
```

The `turnStreamEndMs` is recorded when a `tool_call` event occurs during a turn, because the model stops streaming tokens before making tool calls. If no tool call occurs, `turnStreamEndMs` is null and `turn_end`'s timestamp is used.

### Stream State Machine

```
                  turn_start
                      │
                      ▼
    ┌───────────── waiting
    │                  │
    │         text_delta / thinking_delta
    │                  │
    │                  ▼
    │             streaming ────┐
    │                  │        │
    │     text_delta   │  no token for 3s
    │     received     │        │
    │                  ▼        ▼
    │             streaming  stalled
    │                  ▲        │
    │                  │        │ text_delta
    │                  └────────┘ received
    │                  │
    │            turn_end
    │                  │
    └──────────── idle ◄────── session_start
                      ▲
                      │
                 session_switch
```

### Timer Safety

The stall-check interval is managed with a null-check guard pattern:

```typescript
let stallCheckInterval: ReturnType<typeof setInterval> | null = null;

const clearStallCheck = () => {
  if (stallCheckInterval !== null) {
    clearInterval(stallCheckInterval);
    stallCheckInterval = null;
  }
};
```

Cleared on: `turn_end`, `session_shutdown`, `session_start`, `session_switch`

---

## Shared Conventions

### Code Style

- **TypeScript strict mode** with explicit types
- **No runtime framework dependencies** — only `@mariozechner/pi-coding-agent` and `@mariozechner/pi-ai` as peer dependencies
- **ESM modules** (`"type": "module"` in package.json)
- **Event handler pattern** — async functions receiving `(event, ctx)` with optional return values
- **Atomic file writes** — write to `.tmp` then rename (POSIX atomic)

### Package Structure

Every extension package follows the same layout:

```
<extension-name>/
├── <extension-name>.ts        # Entry point (declared in package.json "pi"."extensions")
├── package.json               # With "pi-package" keyword and "pi"."extensions" field
├── README.md                  # User-facing documentation
└── tests/                     # Test files (optional)
```

### Error Handling

- **Graceful degradation:** If the UI is not available (`!ctx.hasUI`), extensions skip UI operations instead of throwing
- **Try-catch around settings reads:** `loadSettings()` returns `{}` on parse errors
- **Parse failures are safe:** If `shell-quote` can't parse a command, it's treated as HIGH (max restriction)

### Configuration Pattern

Both extensions use `~/.pi/agent/settings.json` for persistent settings. The pattern:

```typescript
function loadSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(getSettingsPath(), "utf-8"));
  } catch {
    return {};
  }
}

function saveSettings(settings: Record<string, unknown>): void {
  // Atomic write: tmp file + rename
}
```

---

## Testing Strategy

### Permission Extension Tests

Located in `permission/tests/permission.test.ts` with 1400+ lines covering:

| Test Category | Count | Examples |
|---------------|-------|---------|
| Minimal commands | ~12 tests | File reading, directory, search, git read, package info |
| Medium commands | ~15 tests | npm install, yarn build, pip install, cargo test, linters |
| High commands | ~8 tests | git push, curl, ssh, docker, unknown commands |
| Dangerous commands | ~5 tests | sudo, rm -rf, chmod 777, dd, mkfs |
| Shell tricks | ~5 tests | $(), backticks, process substitution, eval |
| Safe patterns | ~5 tests | $VAR, ${VAR}, arithmetic $((..)), grep regex |
| Pipelines | ~3 tests | Safe pipes, pipe-to-shell, highest-level-wins |
| Complex commands | ~5 tests | Chained &&/||/; commands, redirections, paths |
| Override system | ~5 tests | Custom patterns, priority, dangerous overrides |
| Prefix mappings | ~5 tests | fvm/nvm/rbenv normalization, combined with overrides |
| Edge cases | ~20 tests | Empty commands, unicode, comments, xargs, tee, find -exec |
| Security | ~4 tests | Override bypass, dangerous mapping, config validation |
| Happy paths | ~5 tests | Typical development workflows (Node, Python, Rust, Go) |

**Run tests:**
```bash
cd permission && npm test
```

The test framework is a lightweight custom runner (no external test framework dependency) with `test()`, `assert()`, `assertEqual()`, and `assertLevel()` helpers.

### Token Rate Extension

No automated tests currently. Manual verification:
1. Start pi with the extension enabled
2. Send a message and observe `…` → `●` → TPS update cycle
3. Verify stall detection by pausing the model mid-stream

---

## Contributing

### Adding a New Extension

1. Create a directory at the repository root: `my-extension/`
2. Create `my-extension.ts` with the extension entry point
3. Create `package.json` with `"pi"."extensions"` and `"pi-package"` keyword
4. Add the extension path to the root `package.json` `"pi"."extensions"` array
5. Add tests in `my-extension/tests/`
6. Write a `README.md` following the existing format

### Adding Commands to the Permission Extension

1. **Read-only commands** → Add to `MINIMAL_COMMANDS` set in `permission-core.ts`
2. **Build/install/test commands** → Add to `MEDIUM_PACKAGE_PATTERNS` array
3. **Code execution commands** → No action needed (unknown = HIGH by default)
4. **New dangerous patterns** → Add to `isDangerousCommand()`
5. Add corresponding test cases in `tests/permission.test.ts`

### Modifying Classification Logic

The classification pipeline is ordered for security — changes should preserve the principle that **more restrictive classifications take precedence**:

1. Shell trick detection → HIGH (can't analyze embedded commands)
2. Override check → user-defined classification
3. Output redirection → LOW minimum
4. Segment-by-segment classification → built-in rules
5. Pipeline analysis → pipe-to-shell detection
6. Maximum across all segments → final result
