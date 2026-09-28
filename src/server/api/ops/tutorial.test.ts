import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Driver } from "../../db/driver";
import { freshDb } from "../../logic/test-support";
import { getTutorialState, setTutorialState } from "./tutorial";

let db: Driver;

beforeEach(() => {
  db = freshDb();
});

afterEach(() => {
  db.close();
});

describe("tutorial state", () => {
  it("starts fresh installs at not_started and round-trips every value", () => {
    expect(getTutorialState(db)).toBe("not_started");
    for (const state of ["in_setup", "done", "not_started"] as const) {
      expect(setTutorialState(db, state)).toEqual({ ok: true });
      expect(getTutorialState(db)).toBe(state);
    }
  });

  it("survives a missing row rather than failing a launch", () => {
    db.prepare("DELETE FROM app_state").run();
    expect(getTutorialState(db)).toBe("not_started");
    setTutorialState(db, "done");
    expect(getTutorialState(db)).toBe("done");
  });
});
