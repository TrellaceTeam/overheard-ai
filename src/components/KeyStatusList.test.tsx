// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { KeyStatusList } from "./KeyStatusList";
import type { KeyStatus } from "./types";

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);

const statuses: KeyStatus[] = [
  { provider: "openai", configured: true, source: "env", result: { state: "untested" } },
  { provider: "anthropic", configured: false, source: "none", result: { state: "untested" } },
];

describe("KeyStatusList", () => {
  it("says which providers have a key in the environment", () => {
    render(<KeyStatusList statuses={statuses} onCheck={() => {}} />);
    expect(screen.getByText("OpenAI")).toBeDefined();
    expect(screen.getByText("key found")).toBeDefined();
    expect(screen.getByText(/No key. Add/)).toBeDefined();
    expect(screen.getByText("ANTHROPIC_API_KEY")).toBeDefined();
  });

  it("runs the paid check only for a configured provider", () => {
    const onCheck = vi.fn();
    render(<KeyStatusList statuses={statuses} onCheck={onCheck} />);
    const buttons = screen.getAllByRole("button", { name: "Check" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(onCheck).toHaveBeenCalledWith("openai");
  });

  it("offers one free Check again while a provider has no key, since .env is read again", () => {
    const onCheck = vi.fn();
    const onRecheckKeys = vi.fn();
    render(<KeyStatusList statuses={statuses} onCheck={onCheck} onRecheckKeys={onRecheckKeys} />);
    expect(screen.getAllByRole("button", { name: "Check again" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onRecheckKeys).toHaveBeenCalledOnce();
    expect(onCheck).not.toHaveBeenCalled();
  });

  it("offers no Check again once every provider has a key", () => {
    render(<KeyStatusList statuses={[statuses[0]!]} onCheck={() => {}} onRecheckKeys={() => {}} />);
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });

  it("offers the key dashboards behind a disclosure", () => {
    render(<KeyStatusList statuses={statuses} onCheck={() => {}} />);
    expect(screen.getByText("Where do I get a key?")).toBeDefined();
    expect(screen.getByText("platform.openai.com/api-keys")).toBeDefined();
    expect(screen.getByText("console.anthropic.com/settings/keys")).toBeDefined();
    expect(screen.getByText("aistudio.google.com/apikey")).toBeDefined();
  });

  it("shows the verdict and the fix hint once a check has run", () => {
    render(
      <KeyStatusList
        statuses={[
          {
            provider: "google",
            configured: true,
            source: "env",
            result: {
              state: "done",
              status: "billing_not_enabled",
              message: "Billing is not enabled on this Google project.",
              hint: "Link a billing account at aistudio.google.com/projects.",
            },
          },
        ]}
        onCheck={() => {}}
      />,
    );
    expect(screen.getByText("Billing is not enabled on this Google project.")).toBeDefined();
    expect(
      screen.getByText("Link a billing account at aistudio.google.com/projects."),
    ).toBeDefined();
  });

  it("says mock provider, not key found, when the offline seam is answering", () => {
    // With OVERHEARD_MOCK_PROVIDERS=1 every provider reports configured with no
    // key anywhere, so an unqualified row would tell a new user their setup is done.
    render(
      <KeyStatusList
        statuses={[
          { provider: "openai", configured: true, source: "mock", result: { state: "untested" } },
        ]}
        onCheck={() => {}}
      />,
    );
    expect(screen.getByText("mock provider")).toBeDefined();
    expect(screen.queryByText("key found")).toBeNull();
  });

  it("carries the tour attribute and says keys never reach the browser", () => {
    const { container } = render(<KeyStatusList statuses={statuses} onCheck={() => {}} />);
    expect(container.querySelector('[data-tour="key-status"]')).not.toBeNull();
    expect(screen.getByText(/never sends keys to the browser/)).toBeDefined();
    expect(screen.getByText(/needs no restart/)).toBeDefined();
  });
});

describe("KeyStatusList without checks (tutorial mode)", () => {
  it("shows the real status but offers nothing to press", () => {
    render(<KeyStatusList statuses={statuses} onCheck={() => {}} showChecks={false} />);
    expect(screen.getByText("key found")).toBeDefined();
    expect(screen.getByText(/No key. Add/)).toBeDefined();
    expect(screen.getByText("ANTHROPIC_API_KEY")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Check/ })).toBeNull();
  });

  it("still lets a row with no key check again, which spends nothing", () => {
    render(
      <KeyStatusList
        statuses={statuses}
        onCheck={() => {}}
        onRecheckKeys={() => {}}
        showChecks={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Check again" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Check" })).toBeNull();
  });
});
