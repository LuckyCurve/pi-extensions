/**
 * Token Rate Status Extension
 *
 * Shows the average output tokens per second (TPS) in the footer status line,
 * plus a real-time stream activity indicator:
 *   ● = streaming (green)
 *   ◌ = stalled, no token for 3s (yellow)
 *   … = waiting for first token (dim)
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Stream state machine
// idle → waiting → streaming ⟷ stalled → idle
type StreamState = "idle" | "waiting" | "streaming" | "stalled";

const STALL_THRESHOLD_MS = 3000;
const CHECK_INTERVAL_MS = 500;

export default function (pi: ExtensionAPI) {
  const statusKey = "token-rate";
  let totalOutputTokens = 0;
  let totalSeconds = 0;
  let turnStartMs: number | null = null;
  let turnStreamEndMs: number | null = null;

  // Stream activity tracking
  let streamState: StreamState = "idle";
  let lastTokenMs: number | null = null;
  let stallCheckInterval: ReturnType<typeof setInterval> | null = null;

  const clearStallCheck = () => {
    if (stallCheckInterval !== null) {
      clearInterval(stallCheckInterval);
      stallCheckInterval = null;
    }
  };

  const startStallCheck = (ctx: { hasUI: boolean; ui: { theme: any; setStatus: (key: string, text?: string) => void } }) => {
    clearStallCheck();
    stallCheckInterval = setInterval(() => {
      if (streamState === "streaming" && lastTokenMs !== null) {
        const elapsed = Date.now() - lastTokenMs;
        if (elapsed >= STALL_THRESHOLD_MS) {
          streamState = "stalled";
          renderStatus(ctx);
        }
      }
    }, CHECK_INTERVAL_MS);
  };

  const reset = (ctx: { hasUI: boolean; ui: { theme: any; setStatus: (key: string, text?: string) => void } }) => {
    totalOutputTokens = 0;
    totalSeconds = 0;
    turnStartMs = null;
    turnStreamEndMs = null;
    streamState = "idle";
    lastTokenMs = null;
    clearStallCheck();
    if (!ctx.hasUI) return;
    const theme = ctx.ui.theme;
    ctx.ui.setStatus(statusKey, theme.fg("dim", "TPS: --"));
  };

  const renderStatus = (ctx: { hasUI: boolean; ui: { theme: any; setStatus: (key: string, text?: string) => void } }) => {
    if (!ctx.hasUI) return;
    const theme = ctx.ui.theme;

    // TPS value part
    let tpsText: string;
    if (totalSeconds <= 0 || totalOutputTokens <= 0) {
      tpsText = theme.fg("dim", "TPS: --");
    } else {
      const tps = totalOutputTokens / totalSeconds;
      const value = Number.isFinite(tps) ? tps.toFixed(1) : "--";
      tpsText = theme.fg("dim", "TPS: ") + theme.fg("accent", `${value} tok/s`);
    }

    // Stream indicator part
    let indicator = "";
    switch (streamState) {
      case "streaming":
        indicator = " " + theme.fg("success", "●");
        break;
      case "stalled":
        indicator = " " + theme.fg("warning", "◌");
        break;
      case "waiting":
        indicator = " " + theme.fg("dim", "…");
        break;
      // idle: no indicator
    }

    ctx.ui.setStatus(statusKey, tpsText + indicator);
  };

  pi.on("session_start", async (_event, ctx) => {
    reset(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    reset(ctx);
  });

  pi.on("session_shutdown", async () => {
    clearStallCheck();
  });

  pi.on("turn_start", async (event, ctx) => {
    turnStartMs = event.timestamp ?? Date.now();
    turnStreamEndMs = null;
    streamState = "waiting";
    lastTokenMs = null;
    startStallCheck(ctx);
    renderStatus(ctx);
  });

  pi.on("message_update", async (event, ctx) => {
    // Only react to actual token deltas
    const evt = event.assistantMessageEvent;
    if (evt?.type !== "text_delta" && evt?.type !== "thinking_delta") return;

    lastTokenMs = Date.now();
    if (streamState === "waiting" || streamState === "stalled") {
      streamState = "streaming";
      renderStatus(ctx);
    }
  });

  pi.on("tool_call", async (_event, _ctx) => {
    if (turnStartMs !== null && turnStreamEndMs === null) {
      turnStreamEndMs = Date.now();
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    clearStallCheck();
    streamState = "idle";
    lastTokenMs = null;

    const message = event.message as AssistantMessage | undefined;
    if (!message || message.role !== "assistant") {
      turnStartMs = null;
      turnStreamEndMs = null;
      renderStatus(ctx);
      return;
    }

    const endMs = turnStreamEndMs ?? event.timestamp ?? Date.now();
    const startMs = turnStartMs ?? endMs;
    const elapsedSeconds = Math.max(0.001, (endMs - startMs) / 1000);

    const outputTokens = message.usage?.output ?? 0;
    if (outputTokens > 0) {
      totalOutputTokens += outputTokens;
      totalSeconds += elapsedSeconds;
    }

    turnStartMs = null;
    turnStreamEndMs = null;
    renderStatus(ctx);
  });
}
