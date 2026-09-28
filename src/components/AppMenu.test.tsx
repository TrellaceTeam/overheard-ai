// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AppMenu, FOOTER_CREDIT } from "./AppMenu";
import { TOUR_SELECTORS } from "./TutorialTour";
import { installDomStubs } from "./test-helpers";

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);

vi.mock("@/components/AppLink", async () => {
  const helpers = await import("./test-helpers");
  return { AppLink: helpers.StubLink };
});

beforeAll(installDomStubs);

const projects = [
  { id: "p1", name: "Acme Analytics" },
  { id: "p2", name: "Northwind Metrics" },
];

function openMenu() {
  fireEvent.click(screen.getByLabelText("Open menu"));
}

describe("AppMenu", () => {
  it("lists every project and marks the active one", () => {
    render(<AppMenu projects={projects} activeProjectId="p2" />);
    openMenu();
    expect(screen.getByText("Acme Analytics")).toBeDefined();
    expect(screen.getByText("Northwind Metrics")).toBeDefined();
  });

  it("always offers New project, because there is no plan cap locally", () => {
    render(<AppMenu projects={projects} activeProjectId="p1" />);
    openMenu();
    expect(screen.getByText("New project")).toBeDefined();
  });

  it("carries the tour's hook on the New project entry itself", () => {
    // The tour's last popup opens the drawer and rings the entry inside it,
    // so the hook lives on the link, not on the button that opens the drawer.
    render(<AppMenu projects={projects} activeProjectId="p1" />);
    expect(screen.getByLabelText("Open menu").getAttribute("data-tour")).toBeNull();
    openMenu();
    expect(screen.getByText("New project").getAttribute("data-tour")).toBe(
      TOUR_SELECTORS.newProject,
    );
  });

  it("keeps account settings and does not repeat the project's own tabs", () => {
    render(<AppMenu projects={projects} activeProjectId="p1" />);
    openMenu();
    expect(screen.getByText("Account settings")).toBeDefined();
    for (const label of ["Dashboard", "Prompts", "Competitors", "Project settings"]) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it("carries no account, billing or team entry", () => {
    render(<AppMenu projects={projects} activeProjectId="p1" />);
    openMenu();
    expect(screen.queryByText(/Billing/)).toBeNull();
    expect(screen.queryByText(/Sign out/)).toBeNull();
    expect(screen.queryByText(/Delete account/)).toBeNull();
  });

  it("credits the maintainer in the footer", () => {
    render(<AppMenu projects={[]} loading={false} />);
    openMenu();
    expect(screen.getByText(FOOTER_CREDIT)).toBeDefined();
    expect(screen.getByText("No projects yet.")).toBeDefined();
  });
});
