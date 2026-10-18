/**
 * src/controller/index.ts — Claude-powered autonomous bot controller
 *
 * Runs a decision loop on interval:
 * 1. Gather system state (ops, errors, queued proposals, connects)
 * 2. Feed state to Claude with tools
 * 3. Claude decides actions (submit, scan, retry, pause, notify)
 * 4. Execute tool calls
 * 5. Log decisions
 *
 * The controller never touches the browser directly — it orchestrates
 * through the existing API layer and services.
 */
import Anthropic from "@anthropic-ai/sdk";
import logger from "../config/logger";
import { toClaudeTools, executeTool, type ToolResult } from "./tools";
import * as control from "../services/process-control";

// ── Config ──

const CONTROLLER_INTERVAL_MS = parseInt(process.env.CONTROLLER_INTERVAL_MS || "120000"); // 2 min default
const CONTROLLER_MODEL = "claude-haiku-4-5-20251001";
const MAX_TOOL_ROUNDS = 5; // max tool use rounds per decision cycle
const MAX_DECISIONS_LOG = 50;

// ── State ──

interface Decision {
  timestamp: string;
  thinking: string;
  actions: Array<{ tool: string; params: Record<string, unknown>; result: ToolResult }>;
  durationMs: number;
}

const _decisions: Decision[] = [];
let _running = false;
let _intervalHandle: ReturnType<typeof setInterval> | null = null;
let _client: Anthropic | null = null;
let _cycleCount = 0;

// ── System prompt ──

const SYSTEM_PROMPT = `You are the autonomous controller for an Upwork outreach agent. Your job is to monitor the pipeline health and make smart decisions to maximize proposal submissions while avoiding waste.

## Your responsibilities:
1. **Monitor** — Check pipeline health, error patterns, queued proposals
2. **Submit** — Submit high-scoring queued proposals when connects are available
3. **Recover** — Retry failed retryable operations
4. **Protect** — Pause systems when errors cascade or connects run low
5. **Scan** — Trigger scans when the queue is empty

## Decision rules:
- ALWAYS start by calling check_pipeline_health to understand current state
- Only submit proposals when connects > 16
- Submit highest-scoring proposals first (score >= 7 preferred)
- If 3+ errors share the same category in recent history, investigate before retrying
- If connects < 8, pause submitting and notify
- Don't trigger scans if one is already running
- Don't submit if the agent is paused
- If everything looks healthy with nothing to do, just return without any tool calls
- Be conservative — wrong submissions waste connects ($0.15-$0.90 each)

## Important:
- You run every ${CONTROLLER_INTERVAL_MS / 1000}s — don't over-optimize in a single cycle
- Prefer doing ONE important thing per cycle over trying everything at once
- Always explain your reasoning briefly before acting`;

// ── Core loop ──

async function runDecisionCycle(): Promise<Decision | null> {
  if (!_client) {
    logger.warn("[controller] No Claude client — skipping cycle");
    return null;
  }
  if (control.getState() === "stopped" || control.getState() === "stopping") {
    return null;
  }

  _cycleCount++;
  const startTime = Date.now();
  const tools = toClaudeTools();
  const actions: Decision["actions"] = [];
  let thinking = "";

  try {
    // Initial message: just ask Claude to assess and act
    let messages: Anthropic.Messages.MessageParam[] = [
      {
        role: "user",
        content: `Cycle #${_cycleCount}. Assess the pipeline and take any needed actions. Current time: ${new Date().toISOString()}`,
      },
    ];

    // Agentic loop — let Claude call tools until it stops
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await _client.messages.create({
        model: CONTROLLER_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });

      // Extract text thinking
      for (const block of response.content) {
        if (block.type === "text") {
          thinking += (thinking ? "\n" : "") + block.text;
        }
      }

      // If no tool use, Claude is done deciding
      const toolUses = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
      );

      if (toolUses.length === 0 || response.stop_reason === "end_turn") {
        break;
      }

      // Execute tool calls
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        const result = await executeTool(toolUse.name, (toolUse.input as Record<string, unknown>) || {});
        actions.push({
          tool: toolUse.name,
          params: (toolUse.input as Record<string, unknown>) || {},
          result,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
        logger.info(`[controller] Tool: ${toolUse.name} → ${result.ok ? "ok" : "error"}`);
      }

      // Feed results back for next round
      messages = [
        ...messages,
        { role: "assistant", content: response.content },
        { role: "user", content: toolResults },
      ];
    }
  } catch (e) {
    logger.error(`[controller] Decision cycle error: ${(e as Error).message}`);
    thinking = `Error: ${(e as Error).message}`;
  }

  const decision: Decision = {
    timestamp: new Date().toISOString(),
    thinking: thinking.slice(0, 500),
    actions,
    durationMs: Date.now() - startTime,
  };

  // Store decision (ring buffer)
  _decisions.push(decision);
  if (_decisions.length > MAX_DECISIONS_LOG) _decisions.shift();

  if (actions.length > 0) {
    logger.info(
      `[controller] Cycle #${_cycleCount}: ${actions.length} action(s) in ${decision.durationMs}ms — ${actions.map(a => a.tool).join(", ")}`,
    );
  } else {
    logger.debug(`[controller] Cycle #${_cycleCount}: no actions needed (${decision.durationMs}ms)`);
  }

  return decision;
}

// ── Public API ──

/**
 * Initialize and start the autonomous controller loop.
 * Uses the same Claude client/auth as the agent.
 */
export function startController(client: Anthropic): void {
  if (_running) {
    logger.warn("[controller] Already running");
    return;
  }

  _client = client;
  _running = true;
  _cycleCount = 0;

  logger.info(`[controller] Starting autonomous controller (interval: ${CONTROLLER_INTERVAL_MS / 1000}s)`);

  // Run first cycle after a short delay (let cron jobs settle)
  setTimeout(() => {
    runDecisionCycle().catch(e => logger.error(`[controller] First cycle error: ${(e as Error).message}`));
  }, 10000);

  // Schedule recurring cycles
  _intervalHandle = setInterval(() => {
    if (!_running) return;
    if (control.getState() === "stopped" || control.getState() === "stopping") {
      stopController();
      return;
    }
    runDecisionCycle().catch(e => logger.error(`[controller] Cycle error: ${(e as Error).message}`));
  }, CONTROLLER_INTERVAL_MS);
}

/**
 * Stop the controller loop.
 */
export function stopController(): void {
  if (!_running) return;
  _running = false;
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
  logger.info("[controller] Controller stopped");
}

/**
 * Run a single decision cycle on demand (for API/testing).
 */
export async function runOneCycle(): Promise<Decision | null> {
  return runDecisionCycle();
}

/**
 * Get controller status and recent decisions.
 */
export function getControllerStatus() {
  return {
    running: _running,
    cycleCount: _cycleCount,
    intervalMs: CONTROLLER_INTERVAL_MS,
    recentDecisions: _decisions.slice(-10).map(d => ({
      timestamp: d.timestamp,
      thinking: d.thinking.slice(0, 200),
      actionCount: d.actions.length,
      actions: d.actions.map(a => a.tool),
      durationMs: d.durationMs,
    })),
  };
}

/**
 * Get full decision log.
 */
export function getDecisionLog() {
  return _decisions;
}

/**
 * Is the controller currently running?
 */
export function isRunning(): boolean {
  return _running;
}
