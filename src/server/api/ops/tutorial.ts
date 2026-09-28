/**
 * The tutorial state: one column in app_state, three values.
 *
 * "not_started" is a fresh install. "in_setup" is a tutorial the user opened
 * and left before the demo existed. The next launch restarts it, because the
 * tutorial is there to keep a new user out of an empty app. "done" is every
 * launch after the demo was created. Migration 0003 sets it at once on a
 * database that already has projects.
 *
 * The routing rule built on these values is pure and lives in lib/launch.ts,
 * where the browser route and its tests can reach it.
 */
import type { Driver } from "../../db/driver";
import { isTutorialState, type TutorialState } from "@/lib/launch";
import { nowIso } from "./shared";

export type { TutorialState };

/** A missing row or an unknown value reads as a fresh install. */
export function getTutorialState(db: Driver): TutorialState {
  const row = db
    .prepare("SELECT tutorial_state FROM app_state WHERE id = 1")
    .get<{ tutorial_state: string }>();
  return isTutorialState(row?.tutorial_state) ? row.tutorial_state : "not_started";
}

export function setTutorialState(db: Driver, state: TutorialState): { ok: true } {
  const changes = db
    .prepare("UPDATE app_state SET tutorial_state = ?, updated_at = ? WHERE id = 1")
    .run(state, nowIso()).changes;
  if (changes === 0) {
    // Migration 0003 inserts the row, so this only runs on a database that
    // lost it. Inserting it here keeps the launch from failing.
    db.prepare("INSERT INTO app_state (id, tutorial_state, updated_at) VALUES (1, ?, ?)").run(
      state,
      nowIso(),
    );
  }
  return { ok: true };
}
