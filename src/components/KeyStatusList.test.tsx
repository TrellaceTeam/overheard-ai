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

  it("keeps how keys are read behind a closed disclosure, not in a block of text", () => {
    render(<KeyStatusList statuses={statuses} onCheck={() => {}} />);
    const explanation = screen.getByText("A key set in your shell wins over the file.");
    expect(explanation.closest("details")?.open).toBe(false);
    expect(screen.getByText("How Overheard AI reads keys")).toBeDefined();
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

  it("offers the plan route beside the key only where a command line tool exists", () => {
    render(
      <KeyStatusList
        statuses={[
          { provider: "openai", configured: false, source: "none", result: { state: "untested" } },
          { provider: "google", configured: false, source: "none", result: { state: "untested" } },
        ]}
        onCheck={() => {}}
      />,
    );
    expect(screen.getByText(/or install Codex and sign in with your plan\./)).toBeDefined();
    expect(screen.getAllByText(/or install/)).toHaveLength(1);
  });

  it("names a plan's models as the plan's, not a key's", () => {
    render(
      <KeyStatusList
        statuses={[
          { provider: "openai", configured: true, source: "cli", result: { state: "untested" } },
        ]}
        onCheck={() => {}}
        availability={{
          openai: { status: "ok", available: ["alpha"], missing: ["beta"], plan: true },
        }}
        modelNames={
          new Map([
            ["alpha", "Assistant Alpha"],
            ["beta", "Assistant Beta"],
          ])
        }
      />,
    );
    expect(
      screen.getByText("Models on your plan: Assistant Alpha. Not on your plan: Assistant Beta."),
    ).toBeDefined();
  });

  it("names the command and the plan when a provider is in subscription mode", () => {
    render(
      <KeyStatusList
        statuses={[
          { provider: "anthropic", configured: true, source: "cli", result: { state: "untested" } },
        ]}
        onCheck={() => {}}
      />,
    );
    expect(screen.getByText("via claude, on your Claude plan")).toBeDefined();
    expect(screen.queryByText("key found")).toBeNull();
  });

  it("names the current models a key can use and the ones it cannot", () => {
    render(
      <KeyStatusList
        statuses={statuses}
        onCheck={() => {}}
        availability={{
          openai: {
            status: "ok",
            available: ["model-a", "model-old"],
            missing: ["model-b"],
          },
        }}
        modelNames={
          new Map([
            ["model-a", "Model A"],
            ["model-b", "Model B"],
          ])
        }
      />,
    );
    // The superseded model has no current name, so it stays off the line.
    expect(
      screen.getByText("Models on this key: Model A. Not on this key: Model B."),
    ).toBeDefined();
  });

  it("says when a key's model list could not be read", () => {
    render(
      <KeyStatusList
        statuses={statuses}
        onCheck={() => {}}
        availability={{ openai: { status: "error", message: "The list could not be read." } }}
        modelNames={new Map()}
      />,
    );
    expect(screen.getByText("The list could not be read.")).toBeDefined();
  });

  it("carries the tour attribute and says keys never reach the browser", () => {
    const { container } = render(<KeyStatusList statuses={statuses} onCheck={() => {}} />);
    expect(container.querySelector('[data-tour="key-status"]')).not.toBeNull();
    expect(screen.getByText(/Keys never reach the browser/)).toBeDefined();
    expect(screen.getByText(/so no restart/)).toBeDefined();
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
