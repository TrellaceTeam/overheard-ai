import { describe, it, expect } from "vitest";
import {
  resolveFeature,
  resolveList,
  listRows,
  CHECK_FAILED,
  LOAD_FAILED,
  type Availability,
} from "./availability";

const OFF = "Scheduled runs are switched off for this project.";

describe("resolveFeature", () => {
  it("reports loading while the query is in flight", () => {
    expect(
      resolveFeature({ isPending: true, isError: false, value: undefined, offReason: OFF }),
    ).toEqual({ state: "loading" });
  });

  it("reports unknown when the query failed", () => {
    expect(
      resolveFeature({ isPending: false, isError: true, value: undefined, offReason: OFF }),
    ).toEqual({ state: "unknown", reason: CHECK_FAILED });
  });

  it("reports unknown when the value is missing rather than false", () => {
    expect(
      resolveFeature({ isPending: false, isError: false, value: undefined, offReason: OFF }),
    ).toEqual({ state: "unknown", reason: CHECK_FAILED });
    expect(
      resolveFeature({ isPending: false, isError: false, value: null, offReason: OFF }),
    ).toEqual({ state: "unknown", reason: CHECK_FAILED });
  });

  it("reports on when the loaded value is true", () => {
    expect(
      resolveFeature({ isPending: false, isError: false, value: true, offReason: OFF }),
    ).toEqual({ state: "on" });
  });

  it("reports off with a real reason only when the loaded value is false", () => {
    expect(
      resolveFeature({ isPending: false, isError: false, value: false, offReason: OFF }),
    ).toEqual({ state: "off", reason: OFF });
  });

  it("never produces off from a pending or errored input", () => {
    const cases: Array<{ isPending: boolean; isError: boolean; value: boolean | undefined }> = [
      { isPending: true, isError: false, value: undefined },
      { isPending: true, isError: false, value: false },
      { isPending: true, isError: true, value: false },
      { isPending: false, isError: true, value: false },
    ];
    for (const c of cases) {
      const result: Availability = resolveFeature({ ...c, offReason: OFF });
      expect(result.state).not.toBe("off");
    }
  });

  it("uses a caller-supplied error reason when given", () => {
    expect(
      resolveFeature({
        isPending: false,
        isError: true,
        value: undefined,
        offReason: OFF,
        errorReason: "Could not reach the database.",
      }),
    ).toEqual({ state: "unknown", reason: "Could not reach the database." });
  });
});

describe("resolveList", () => {
  it("distinguishes loading, failure, empty and ready", () => {
    expect(resolveList({ isPending: true, isError: false, rows: undefined })).toEqual({
      state: "loading",
    });
    expect(resolveList({ isPending: false, isError: true, rows: undefined })).toEqual({
      state: "unknown",
      reason: LOAD_FAILED,
    });
    expect(resolveList({ isPending: false, isError: false, rows: undefined })).toEqual({
      state: "unknown",
      reason: LOAD_FAILED,
    });
    expect(resolveList({ isPending: false, isError: false, rows: [] })).toEqual({ state: "empty" });
    expect(resolveList({ isPending: false, isError: false, rows: [1, 2] })).toEqual({
      state: "ready",
      rows: [1, 2],
    });
  });

  it("never claims empty from unloaded data", () => {
    expect(resolveList({ isPending: true, isError: false, rows: [] }).state).toBe("loading");
    expect(resolveList({ isPending: false, isError: true, rows: [] }).state).toBe("unknown");
  });

  it("yields rows only when ready", () => {
    expect(listRows(resolveList({ isPending: true, isError: false, rows: [1] }))).toEqual([]);
    expect(listRows(resolveList({ isPending: false, isError: false, rows: [1] }))).toEqual([1]);
  });
});

describe("state copy", () => {
  it("keeps the four states distinguishable to a reader", () => {
    const copies = new Set([CHECK_FAILED, LOAD_FAILED, OFF, "loading"]);
    expect(copies.size).toBe(4);
  });
});
