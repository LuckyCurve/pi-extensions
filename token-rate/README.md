# Token Rate Extension

Real-time token throughput indicator for [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) — displays average output tokens per second (TPS) and stream activity status in the footer bar.

## Overview

The extension tracks token output across assistant turns and computes a running average TPS, displayed in the pi status line. It also provides a real-time stream activity indicator so you can tell at a glance whether the model is actively streaming, stalled, or waiting for its first token.

### Status Line Display

```
TPS: 42.3 tok/s ●     ← streaming (green dot)
TPS: 42.3 tok/s ◌     ← stalled, no token for 3s (yellow circle)
TPS: 42.3 tok/s …     ← waiting for first token (dim ellipsis)
TPS: --                ← no data yet / idle
```

| Indicator | State | Meaning |
|-----------|-------|---------|
| `●` (green) | `streaming` | Receiving tokens actively |
| `◌` (yellow) | `stalled` | No token received for 3+ seconds |
| `…` (dim) | `waiting` | Turn started, waiting for first token |
| (none) | `idle` | Between turns or no active stream |

## Installation

### As a standalone package

```bash
pi install npm:token-rate-pi
pi config
```

Enable `token-rate` in the `pi config` menu. Dependencies are installed automatically.

### As part of pi-extensions

```bash
git clone https://github.com/user/pi-extensions.git
cd pi-extensions
npm install
pi config
```

## How It Works

### TPS Calculation

TPS is computed as a **cumulative average** across all assistant turns in the current session:

```
TPS = totalOutputTokens / totalStreamingSeconds
```

Where:
- `totalOutputTokens` — sum of `message.usage.output` across all completed turns
- `totalStreamingSeconds` — sum of wall-clock time from `turn_start` to the last token before a tool call or `turn_end`

Only turns that produce output tokens are counted. Turns with zero output tokens (e.g., pure tool calls) are excluded from the average.

### Stream State Machine

```
idle → waiting → streaming ⟷ stalled → idle
                ↑            │
                └────────────┘ (token received within 3s)
```

| Transition | Trigger |
|------------|---------|
| `idle` → `waiting` | `turn_start` event |
| `waiting` → `streaming` | First `text_delta` or `thinking_delta` received |
| `streaming` → `stalled` | No token for 3000ms (checked every 500ms) |
| `stalled` → `streaming` | New `text_delta` or `thinking_delta` received |
| `*` → `idle` | `turn_end` event |

### Event Hook Points

The extension hooks into the following pi lifecycle events:

| Event | Purpose |
|-------|---------|
| `session_start` | Reset all counters and status |
| `session_switch` | Reset all counters and status |
| `session_shutdown` | Clean up stall-check interval timer |
| `turn_start` | Record turn start time, set state to `waiting` |
| `message_update` | Detect `text_delta` / `thinking_delta`, mark streaming |
| `tool_call` | Record stream end time (tokens stop before tool calls) |
| `turn_end` | Calculate TPS from turn, accumulate totals, set idle |

## Configuration

No configuration required. The extension works out of the box.

### Tuning Constants

If you want to adjust the stall detection sensitivity, edit `token-rate.ts`:

| Constant | Default | Description |
|----------|---------|-------------|
| `STALL_THRESHOLD_MS` | `3000` | Milliseconds without a token before marking as stalled |
| `CHECK_INTERVAL_MS` | `500` | How often to check for stalls |

## Technical Details

### Timer Management

The stall-check timer is carefully managed to prevent leaks:
- Created on `turn_start` via `setInterval`
- Cleared on `turn_end` and `session_shutdown`
- Guarded against duplicate intervals via null-check pattern

### Theme Integration

The status text uses `ctx.ui.theme` for consistent coloring:
- `theme.fg("dim", ...)` — labels and idle states
- `theme.fg("accent", ...)` — TPS value
- `theme.fg("success", ...)` — streaming indicator (●)
- `theme.fg("warning", ...)` — stalled indicator (◌)

This ensures the extension adapts to any pi color theme automatically.

### Non-Interactive Mode

In non-interactive / print mode (`pi -p`), the extension gracefully degrades — `ctx.hasUI` is `false`, so status updates are skipped. No errors are thrown.

## File Structure

```
token-rate/
├── token-rate.ts    # Extension entry point — all logic in one file
├── package.json     # Declares extension via "pi" field
└── README.md        # This documentation
```

## Compatibility

- **pi-coding-agent** ≥ 0.50.0
- **pi-ai** ≥ 0.50.0 (for `AssistantMessage` type)

## License

MIT (see repository root)
