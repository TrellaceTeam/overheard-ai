/**
 * Stores one perception summary scope, replacing whatever was there. The demo
 * generator uses it too, so it lives here and not in the worker.
 *
 * Delete then insert, not upsert, because the uniqueness that matters is on
 * (project_id, coalesce(model_id, '')), an expression index that ON CONFLICT
 * cannot name. The null-model scope is matched with IS NULL, never `= ?`: a
 * parameterised equality against NULL matches nothing and would leave the old
 * aggregate in place beside the new one.
 */
import { randomUUID } from "node:crypto";
import type { Driver } from "../db/driver";

export interface PerceptionSummaryInput {
  knows_brand: boolean;
  what_it_does: string;
  typical_customers: string;
  well_regarded_for: string;
  downsides: string;
  run_id: string | null;
  question_text: string | null;
  source_answers: number;
}

export function writePerceptionSummary(
  db: Driver,
  projectId: string,
  modelId: string | null,
  row: PerceptionSummaryInput,
): void {
  const now = new Date().toISOString();
  db.transaction(() => {
    if (modelId === null) {
      db.prepare("DELETE FROM perception_summaries WHERE project_id = ? AND model_id IS NULL").run(
        projectId,
      );
    } else {
      db.prepare("DELETE FROM perception_summaries WHERE project_id = ? AND model_id = ?").run(
        projectId,
        modelId,
      );
    }
    db.prepare(
      `INSERT INTO perception_summaries
         (id, project_id, model_id, run_id, question_text, knows_brand, what_it_does,
          typical_customers, well_regarded_for, downsides, source_answers, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      projectId,
      modelId,
      row.run_id,
      row.question_text,
      row.knows_brand ? 1 : 0,
      row.what_it_does,
      row.typical_customers,
      row.well_regarded_for,
      row.downsides,
      row.source_answers,
      now,
      now,
    );
  });
}
