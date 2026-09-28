import { describe, expect, it } from "vitest";
import {
  INFLIGHT_CAP_MAX,
  INFLIGHT_CAP_MIN,
  isInflightCap,
  parseInflightCap,
} from "./inflight-caps";

describe("parseInflightCap", () => {
  it("takes a plain whole number inside the column's bounds", () => {
    expect(parseInflightCap("4")).toBe(4);
    expect(parseInflightCap(String(INFLIGHT_CAP_MIN))).toBe(1);
    expect(parseInflightCap(String(INFLIGHT_CAP_MAX))).toBe(15);
  });

  it("forgives the spaces around a typed number", () => {
    expect(parseInflightCap(" 8 ")).toBe(8);
  });

  it("is null for anything the column would refuse, so the field can say so", () => {
    expect(parseInflightCap("")).toBeNull();
    expect(parseInflightCap("lots")).toBeNull();
    expect(parseInflightCap("1.5")).toBeNull();
    expect(parseInflightCap("-5")).toBeNull();
    expect(parseInflightCap("0")).toBeNull();
    expect(parseInflightCap("16")).toBeNull();
  });
});

describe("isInflightCap", () => {
  it("admits the bounds and nothing past them", () => {
    expect(isInflightCap(1)).toBe(true);
    expect(isInflightCap(15)).toBe(true);
    expect(isInflightCap(0)).toBe(false);
    expect(isInflightCap(16)).toBe(false);
    expect(isInflightCap(2.5)).toBe(false);
    expect(isInflightCap(Number.NaN)).toBe(false);
  });
});
