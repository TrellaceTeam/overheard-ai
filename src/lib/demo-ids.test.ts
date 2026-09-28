import { describe, expect, it } from "vitest";
import { DEMO_WEEKS, demoRunId, demoShowcaseRunId } from "./demo-ids";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("demoRunId", () => {
  it("is deterministic: the same index gives the same id, always", () => {
    expect(demoRunId(7)).toBe(demoRunId(7));
    expect(demoRunId(DEMO_WEEKS - 1)).toBe(demoShowcaseRunId());
  });

  it("gives every week its own id, the perception run included", () => {
    const ids = new Set<string>();
    for (let week = 0; week <= DEMO_WEEKS; week += 1) ids.add(demoRunId(week));
    expect(ids.size).toBe(DEMO_WEEKS + 1);
  });

  it("is v4-shaped, so nothing that expects a UUID can tell", () => {
    for (const week of [0, 14, DEMO_WEEKS - 1, DEMO_WEEKS]) {
      expect(demoRunId(week)).toMatch(UUID_V4);
    }
  });
});
