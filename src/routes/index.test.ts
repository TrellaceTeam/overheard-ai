// @vitest-environment jsdom
/**
 * The front door has no logic of its own: it reads two server operations and
 * redirects, so only its title is pinned here.
 */
import { describe, expect, it } from "vitest";
import { Route } from "./index";

describe("route metadata", () => {
  it("names Overheard AI and carries no vendor or tooling name", async () => {
    const head = await Route.options.head?.({} as never);
    const titles = (head?.meta ?? []).map((entry) => entry?.title).filter(Boolean);
    expect(titles).toEqual(["Overheard AI"]);
  });
});
