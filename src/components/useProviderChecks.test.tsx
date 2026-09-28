// @vitest-environment jsdom
/**
 * The provider-check machine, tested as a machine: rows in, statuses out, and
 * the checking → done transitions. No route is rendered, which is the point of
 * the hook.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useProviderChecks } from "./useProviderChecks";
import { setupCheck } from "@/server/api/settings";
import type { SetupCheckReport } from "@/server/api/settings";
import type { KeyStatus } from "./types";

vi.mock("@/server/api/settings", () => ({
  setupCheck: vi.fn(),
}));

const checkMock = vi.mocked(setupCheck);

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const rows = [
  { provider: "openai" as const, configured: true, source: "env" as const },
  { provider: "anthropic" as const, configured: false, source: "none" as const },
];

function reportWith(result: { status: string; message: string; hint?: string }): SetupCheckReport {
  return {
    checkedAt: "2026-09-25T12:00:00.000Z",
    rows: [
      {
        kind: "assistant",
        provider: "openai",
        modelId: "gpt-x",
        displayName: "GPT X",
        result,
      },
    ],
  } as SetupCheckReport;
}

describe("useProviderChecks", () => {
  it("joins the key rows with untested results", () => {
    const { result } = renderHook(() => useProviderChecks(rows));
    expect(result.current.statuses).toEqual([
      {
        provider: "openai",
        configured: true,
        source: "env",
        problem: null,
        result: { state: "untested" },
      },
      {
        provider: "anthropic",
        configured: false,
        source: "none",
        problem: null,
        result: { state: "untested" },
      },
    ] satisfies KeyStatus[]);
  });

  it("shows no statuses while the key query has not landed", () => {
    const { result } = renderHook(() => useProviderChecks(undefined));
    expect(result.current.statuses).toEqual([]);
  });

  it("walks one provider checking → done with the report's verdict", async () => {
    checkMock.mockResolvedValue(reportWith({ status: "ok", message: "All good" }));
    const { result } = renderHook(() => useProviderChecks(rows));

    let running!: Promise<void>;
    act(() => {
      running = result.current.check("openai");
    });
    expect(result.current.statuses[0]!.result).toEqual({ state: "checking" });
    // The other provider's row is untouched by a check of the first.
    expect(result.current.statuses[1]!.result).toEqual({ state: "untested" });

    await act(async () => {
      await running;
    });
    expect(checkMock).toHaveBeenCalledWith({ data: { provider: "openai" } });
    expect(result.current.statuses[0]!.result).toEqual({
      state: "done",
      status: "ok",
      message: "All good",
      hint: undefined,
    });
  });

  it("carries the hint through when the verdict has one", async () => {
    checkMock.mockResolvedValue(
      reportWith({ status: "no_credits", message: "No credit", hint: "Add credit at …" }),
    );
    const { result } = renderHook(() => useProviderChecks(rows));
    await act(async () => {
      await result.current.check("openai");
    });
    expect(result.current.statuses[0]!.result).toEqual({
      state: "done",
      status: "no_credits",
      message: "No credit",
      hint: "Add credit at …",
    });
  });

  it("reports an empty report as an unknown verdict rather than a silent pass", async () => {
    checkMock.mockResolvedValue({ checkedAt: "x", rows: [] } as SetupCheckReport);
    const { result } = renderHook(() => useProviderChecks(rows));
    await act(async () => {
      await result.current.check("openai");
    });
    expect(result.current.statuses[0]!.result).toEqual({
      state: "done",
      status: "unknown",
      message: "The check returned no result.",
    });
  });

  it("turns a thrown check into a readable unknown verdict", async () => {
    checkMock.mockRejectedValue(new Error("database is locked"));
    const { result } = renderHook(() => useProviderChecks(rows));
    await act(async () => {
      await result.current.check("openai");
    });
    expect(result.current.statuses[0]!.result).toEqual({
      state: "done",
      status: "unknown",
      message: "Database is locked",
    });
  });

  it("falls back to its own sentence when the throw carries nothing readable", async () => {
    checkMock.mockRejectedValue("network");
    const { result } = renderHook(() => useProviderChecks(rows));
    await act(async () => {
      await result.current.check("openai");
    });
    expect(result.current.statuses[0]!.result).toEqual({
      state: "done",
      status: "unknown",
      message: "Could not run the setup check",
    });
  });
});
