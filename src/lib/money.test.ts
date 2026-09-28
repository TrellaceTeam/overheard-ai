import { describe, expect, it } from "vitest";
import { money } from "./money";

describe("money", () => {
  it("shows fractions of a cent instead of rounding them to zero", () => {
    expect(money(0)).toBe("$0.00");
    expect(money(0.0042)).toBe("$0.0042");
    expect(money(1.23456)).toBe("$1.23");
    expect(money(16)).toBe("$16.00");
  });
});
