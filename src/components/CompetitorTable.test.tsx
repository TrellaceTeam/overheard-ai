// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { CompetitorTable } from "./CompetitorTable";
import type { CompetitorRow } from "./types";
import type { Agg } from "@/lib/metrics";

// Vitest runs without globals, so the library's own cleanup hook never
// registers itself. Without this, every render stacks up in one document.
afterEach(cleanup);

const agg = (over: Partial<Agg> = {}): Agg => ({
  answers: 8,
  mentions: 2,
  ranked: 1,
  citations: 0,
  mention_rate: 0.25,
  rank_rate: 0.125,
  citation_rate: 0,
  top3_rate: 0.125,
  top_pick_share: 0,
  share_of_voice: 0.4,
  ...over,
});

const rows: CompetitorRow[] = [
  { brand: { id: "b1", name: "Acme Analytics", role: "target" }, agg: agg() },
  {
    brand: { id: "b2", name: "Northwind Metrics", role: "competitor" },
    agg: agg({ mention_rate: 0.5 }),
  },
];

describe("CompetitorTable", () => {
  it("renders one row per brand with its rates", () => {
    render(<CompetitorTable rows={rows} />);
    expect(screen.getByText("Acme Analytics")).toBeDefined();
    expect(screen.getByText("Northwind Metrics")).toBeDefined();
    expect(screen.getByText("50%")).toBeDefined();
  });

  it("shows the empty string rather than a bare table", () => {
    render(<CompetitorTable rows={[]} empty="Nothing observed yet." />);
    expect(screen.getByText("Nothing observed yet.")).toBeDefined();
  });

  describe("the inline Track column", () => {
    const discovered: CompetitorRow[] = [
      ...rows,
      {
        brand: { id: "b3", name: "Stray Brand", role: "discovered" },
        agg: agg({ mention_rate: 0.1 }),
      },
    ];

    it("is absent unless the screen asks for it", () => {
      render(<CompetitorTable rows={discovered} />);
      expect(screen.queryByText("Track")).toBeNull();
    });

    it("offers Track on discovered rows only, and calls through with the brand", () => {
      const onTrack = vi.fn();
      render(<CompetitorTable rows={discovered} track={{ onTrack, busyId: null, locked: null }} />);
      const buttons = screen.getAllByText("Track");
      expect(buttons).toHaveLength(1);
      fireEvent.click(buttons[0]!);
      expect(onTrack).toHaveBeenCalledWith(discovered[2]!.brand);
    });

    it("disables the button on the row being tracked", () => {
      render(
        <CompetitorTable
          rows={discovered}
          track={{ onTrack: () => {}, busyId: "b3", locked: null }}
        />,
      );
      expect((screen.getByRole("button", { name: /Track/i }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });

    it("locks every Track button for the demo project and says why", () => {
      render(
        <CompetitorTable
          rows={discovered}
          track={{ onTrack: () => {}, busyId: null, locked: "demo" }}
        />,
      );
      const locked = screen.getByRole("button", { name: /Track/i }) as HTMLButtonElement;
      expect(locked.disabled).toBe(true);
      expect(locked.title).toBe("demo");
    });
  });
});
