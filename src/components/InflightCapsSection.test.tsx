// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { InflightCapsSection } from "./InflightCapsSection";
import type { InflightCapView } from "@/server/api/settings";

afterEach(cleanup);

function cap(patch: Partial<InflightCapView> & Pick<InflightCapView, "provider">): InflightCapView {
  return {
    effective: 6,
    defaultCap: 6,
    stored: null,
    envName: `OVERHEARD_MAX_INFLIGHT_${patch.provider.toUpperCase()}`,
    envOverrides: false,
    ...patch,
  };
}

const DEFAULTS: InflightCapView[] = [
  cap({ provider: "openai" }),
  cap({ provider: "anthropic" }),
  cap({ provider: "google", effective: 3, defaultCap: 3 }),
];

/** The field and the buttons on its row. */
function row(label: string) {
  const field = screen.getByLabelText(label) as HTMLInputElement;
  const buttons = within(field.parentElement!);
  return {
    field,
    save: buttons.getByRole("button", { name: /Save/ }),
    reset: buttons.getByRole("button", { name: "Reset to default" }),
  };
}

describe("InflightCapsSection", () => {
  it("shows one field per provider with the cap that applies, and the defaults", () => {
    render(<InflightCapsSection caps={DEFAULTS} readFailed={false} onCommit={vi.fn()} />);

    expect(row("OpenAI calls in flight").field.value).toBe("6");
    expect(row("Anthropic calls in flight").field.value).toBe("6");
    expect(row("Google calls in flight").field.value).toBe("3");
    expect(
      screen.getByText(
        "Lower a provider's number if your key's tier returns rate-limit errors. A higher number can finish a run sooner, and it never changes what the run costs, because providers do not bill a rate-limited call.",
      ),
    ).toBeDefined();
    expect(screen.getByText("Defaults: OpenAI 6, Anthropic 6, Google 3.")).toBeDefined();
  });

  it("saves the typed number for that provider only", async () => {
    const onCommit = vi.fn(async () => true);
    render(<InflightCapsSection caps={DEFAULTS} readFailed={false} onCommit={onCommit} />);
    const google = row("Google calls in flight");

    fireEvent.change(google.field, { target: { value: "2" } });
    fireEvent.click(google.save);

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("google", 2));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("says what is wrong instead of sending a cap the server would refuse", () => {
    const onCommit = vi.fn(async () => true);
    render(<InflightCapsSection caps={DEFAULTS} readFailed={false} onCommit={onCommit} />);
    const openai = row("OpenAI calls in flight");

    fireEvent.change(openai.field, { target: { value: "40" } });
    fireEvent.click(openai.save);

    expect(screen.getByText("Enter a whole number between 1 and 15.")).toBeDefined();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("keeps what was typed when the save fails", async () => {
    const onCommit = vi.fn(async () => false);
    render(<InflightCapsSection caps={DEFAULTS} readFailed={false} onCommit={onCommit} />);
    const openai = row("OpenAI calls in flight");

    fireEvent.change(openai.field, { target: { value: "4" } });
    fireEvent.click(openai.save);

    await waitFor(() => expect(onCommit).toHaveBeenCalled());
    expect(openai.field.value).toBe("4");
  });

  it("resets a saved cap with null, and offers no reset when nothing is saved", async () => {
    const onCommit = vi.fn(async () => true);
    const caps = [cap({ provider: "openai", effective: 2, stored: 2 }), ...DEFAULTS.slice(1)];
    render(<InflightCapsSection caps={caps} readFailed={false} onCommit={onCommit} />);

    expect(row("Anthropic calls in flight").reset.hasAttribute("disabled")).toBe(true);
    fireEvent.click(row("OpenAI calls in flight").reset);

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("openai", null));
  });

  it("makes a field read-only and names the variable when the environment wins", () => {
    const caps = [
      cap({ provider: "openai", effective: 9, stored: 2, envOverrides: true }),
      ...DEFAULTS.slice(1),
    ];
    render(<InflightCapsSection caps={caps} readFailed={false} onCommit={vi.fn()} />);
    const openai = row("OpenAI calls in flight");

    expect(openai.field.value).toBe("9");
    expect(openai.field.readOnly).toBe(true);
    expect(openai.save.hasAttribute("disabled")).toBe(true);
    expect(openai.reset.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "P" &&
          element.textContent ===
            "OVERHEARD_MAX_INFLIGHT_OPENAI is set in your environment, and it wins over this field.",
      ),
    ).toBeDefined();
    expect(row("Anthropic calls in flight").field.readOnly).toBe(false);
  });

  it("says so when the caps cannot be read", () => {
    render(<InflightCapsSection caps={undefined} readFailed={true} onCommit={vi.fn()} />);
    expect(
      screen.getByText("We could not read the calls in flight just now. Reload to try again."),
    ).toBeDefined();
    expect(screen.queryByText("Reading the caps…")).toBeNull();
  });
});
