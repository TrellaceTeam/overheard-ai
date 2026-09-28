/**
 * The local token and cost log. It answers one question on the run screen: what
 * did this run cost on your keys. Every figure is an estimate from the catalogue
 * list prices and is labelled as one.
 */
import { randomUUID } from "node:crypto";
import type { Driver } from "../db/driver";
import type { UsageEventInput } from "./types";

/** One row per provider call, of any kind, success or failure. */
export function recordUsageEvent(db: Driver, event: UsageEventInput): void {
  db.prepare(
    `INSERT INTO usage_events
       (id, run_id, run_task_id, kind, provider, model_id, input_tokens, output_tokens,
        search_calls, cost_usd, cost_estimated, outcome, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    event.runId,
    event.runTaskId,
    event.kind,
    event.provider,
    event.modelId,
    event.inputTokens,
    event.outputTokens,
    event.searchCalls,
    event.costUsd,
    event.costEstimated ? 1 : 0,
    event.outcome,
    new Date().toISOString(),
  );
}

/** What a run has spent so far in USD, every kind summed. An estimate from list prices. */
export function runUsageTotal(db: Driver, runId: string): number {
  const row = db
    .prepare("SELECT coalesce(sum(cost_usd), 0) AS total FROM usage_events WHERE run_id = ?")
    .get<{ total: number }>(runId);
  return row?.total ?? 0;
}
