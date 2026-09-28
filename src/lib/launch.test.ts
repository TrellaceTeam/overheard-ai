import { describe, expect, it } from "vitest";
import {
  afterDeleteDestination,
  firstLaunchDestination,
  isTutorialMode,
  isTutorialState,
} from "./launch";

describe("firstLaunchDestination", () => {
  it("sends an unfinished tutorial to the tutorial, whatever else exists", () => {
    expect(
      firstLaunchDestination({ tutorialState: "not_started", mostRecentProjectId: null }),
    ).toEqual({ to: "tutorial" });
    expect(
      firstLaunchDestination({ tutorialState: "in_setup", mostRecentProjectId: "p1" }),
    ).toEqual({ to: "tutorial" });
  });

  it("opens the most recent project once the tutorial is done", () => {
    expect(firstLaunchDestination({ tutorialState: "done", mostRecentProjectId: "p1" })).toEqual({
      to: "project",
      projectId: "p1",
    });
  });

  it("opens New project when the tutorial is done and nothing is left", () => {
    // The demo-deleted-with-nothing-else case: done, no projects, no tutorial.
    expect(firstLaunchDestination({ tutorialState: "done", mostRecentProjectId: null })).toEqual({
      to: "new-project",
    });
  });
});

describe("afterDeleteDestination", () => {
  it("sends the last project's deletion straight to New project, past the front door", () => {
    // Going via "/" would work but flash "opening your projects…" on the way;
    // both router outcomes for an empty database live on /start anyway.
    expect(afterDeleteDestination(null)).toEqual({ to: "start" });
  });

  it("leaves the front door to route when a project remains", () => {
    // "/" re-reads the tutorial state too; a delete handler that guessed the
    // destination itself could skip an interrupted tutorial.
    expect(afterDeleteDestination("p2")).toEqual({ to: "home" });
  });

  it("treats an unreadable read of what remains as 'not confirmed empty'", () => {
    expect(afterDeleteDestination(undefined)).toEqual({ to: "home" });
  });
});

describe("isTutorialMode", () => {
  it("is on until the state is definitely done", () => {
    expect(isTutorialMode("not_started")).toBe(true);
    expect(isTutorialMode("in_setup")).toBe(true);
    expect(isTutorialMode("done")).toBe(false);
  });

  it("reads an unreadable state as done, so a failed query never traps anyone", () => {
    expect(isTutorialMode(undefined)).toBe(false);
    expect(isTutorialMode("nonsense")).toBe(false);
    expect(isTutorialState("nonsense")).toBe(false);
  });
});
