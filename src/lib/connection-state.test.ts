import { describe, expect, it } from "vitest";
import { connectionLost } from "./connection-state";

const ok = { errored: false, failureCount: 0 };
const failed = { errored: true, failureCount: 3 };

describe("connectionLost", () => {
  it("is quiet while everything is fine", () => {
    expect(connectionLost([ok, ok, ok])).toBe(false);
  });

  it("is quiet for a single failing query, which is a bug not an outage", () => {
    expect(connectionLost([ok, ok, failed])).toBe(false);
  });

  it("reports the server gone once two queries are failing", () => {
    expect(connectionLost([ok, failed, failed])).toBe(true);
  });

  it("ignores an error that has not actually failed a fetch", () => {
    expect(connectionLost([{ errored: true, failureCount: 0 }, failed])).toBe(false);
  });

  it("is quiet with nothing to judge", () => {
    expect(connectionLost([])).toBe(false);
  });
});
