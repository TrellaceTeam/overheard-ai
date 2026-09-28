// @vitest-environment jsdom
/**
 * The settings screen's own logic: the byte count and call-limit formats, the
 * route metadata, and the Run tutorial again button.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { formatSize, parseCallLimit, Route } from "./settings";

const settingsMocks = vi.hoisted(() => ({
  setTutorial: vi.fn(async () => ({ ok: true as const })),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => settingsMocks.navigate,
}));
vi.mock("@/server/api/tutorial", () => ({ setTutorial: settingsMocks.setTutorial }));
// The rest of the screen can stay loading: the button under test waits on
// none of it.
vi.mock("@/server/api/demo", () => ({
  demoState: () => new Promise<never>(() => {}),
  restoreDemoProject: () => new Promise<never>(() => {}),
}));
vi.mock("@/server/api/settings", () => ({
  keyStatus: () => new Promise<never>(() => {}),
  databaseInfo: () => new Promise<never>(() => {}),
  workerStatus: () => new Promise<never>(() => {}),
  callLimit: () => new Promise<never>(() => {}),
  setCallLimit: () => new Promise<never>(() => {}),
  inflightCaps: () => new Promise<never>(() => {}),
  setInflightCap: () => new Promise<never>(() => {}),
  setupCheck: () => new Promise<never>(() => {}),
}));

afterEach(cleanup);

describe("formatSize", () => {
  it("says so when the database is in memory", () => {
    expect(formatSize(null)).toBe("in memory");
  });

  it("leaves small files in bytes", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
  });

  it("climbs a unit at a time", () => {
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatSize(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });

  it("drops the decimal once the number is wide enough not to need it", () => {
    expect(formatSize(40 * 1024)).toBe("40 KB");
  });

  it("stops at gigabytes rather than inventing a unit", () => {
    expect(formatSize(4096 * 1024 * 1024 * 1024)).toBe("4096 GB");
  });
});

describe("parseCallLimit", () => {
  it("takes a plain whole number inside the column's bounds", () => {
    expect(parseCallLimit("250")).toBe(250);
    expect(parseCallLimit("1")).toBe(1);
    expect(parseCallLimit("10000000")).toBe(10000000);
  });

  it("forgives the spaces and separators people type into number fields", () => {
    expect(parseCallLimit(" 500 000 ")).toBe(500000);
    expect(parseCallLimit("500,000")).toBe(500000);
    expect(parseCallLimit("500_000")).toBe(500000);
  });

  it("is null for anything the column would refuse, so the field can say so", () => {
    expect(parseCallLimit("")).toBeNull();
    expect(parseCallLimit("lots")).toBeNull();
    expect(parseCallLimit("1.5")).toBeNull();
    expect(parseCallLimit("-5")).toBeNull();
    expect(parseCallLimit("0")).toBeNull();
    expect(parseCallLimit("10000001")).toBeNull();
  });
});

describe("route metadata", () => {
  it("names Overheard AI", async () => {
    const head = await Route.options.head?.({} as never);
    const titles = (head?.meta ?? []).map((entry) => entry?.title).filter(Boolean);
    expect(titles).toEqual(["Account settings - Overheard AI"]);
  });
});

/* ------------------------------------------------------ Run tutorial again */

describe("Run tutorial again", () => {
  it("reopens the tutorial through its state alone, with no flag in storage", async () => {
    // /start becomes the tutorial again because the state says "in setup".
    // No re-run flag goes into storage: every tour ends in the same place, so
    // no flag has to say where.
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Settings = Route.options.component;
    if (!Settings) throw new Error("the route has no component");
    render(createElement(QueryClientProvider, { client }, createElement(Settings)));

    fireEvent.click(screen.getByRole("button", { name: "Run tutorial again" }));

    await waitFor(() => expect(settingsMocks.navigate).toHaveBeenCalledWith({ to: "/start" }));
    expect(settingsMocks.setTutorial).toHaveBeenCalledWith({ data: { state: "in_setup" } });
    expect(client.getQueryData(["tutorial-state"])).toBe("in_setup");
    const written = setItem.mock.calls.map(([key]) => key);
    setItem.mockRestore();
    expect(written).not.toContain("tutorial:rerun");
  });
});
