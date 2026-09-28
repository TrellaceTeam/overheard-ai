import { describe, expect, it } from "vitest";
import { aggregate, sumAnswers, type MetricRow } from "./metrics";

let seq = 0;

/** A metric row with the fields a test does not care about filled in. */
function row(partial: Partial<MetricRow> = {}): MetricRow {
  return {
    id: `row-${++seq}`,
    run_id: "run-1",
    brand_id: "brand-a",
    model_id: "model-1",
    prompt_id: "prompt-1",
    answers: 10,
    mentions: 0,
    ranked: 0,
    citations: 0,
    top_pick_share: null,
    top3_rate: null,
    created_at: "2026-09-02T00:00:00Z",
    ...partial,
  };
}

describe("aggregate: top3_rate", () => {
  it("is the share of all answers, over one scope", () => {
    const rows = [row({ answers: 50, mentions: 30, top3_rate: 0.4 })];
    expect(aggregate(rows).top3_rate).toBeCloseTo(0.4, 10);
  });

  it("weights each scope by its own answers, not by scope count", () => {
    // Averaging the two stored rates gives 0.75. The truth is 60 top-three
    // answers out of 110, because the 100-answer scope has to count ten times
    // as much as the 10-answer one.
    const rows = [
      row({ model_id: "m1", answers: 100, mentions: 80, top3_rate: 0.5 }),
      row({ model_id: "m2", answers: 10, mentions: 10, top3_rate: 1 }),
    ];
    const agg = aggregate(rows);
    expect(agg.answers).toBe(110);
    expect(agg.top3_rate).toBeCloseTo(60 / 110, 6);
    expect(agg.top3_rate).not.toBeCloseTo(0.75, 2);
  });

  it("divides by every answer in scope, not only the ones that mentioned you", () => {
    // A brand has rows only where it was observed. Using its own rows as the
    // denominator would report top 3 on the answers it appeared in, which is a
    // different and much more flattering number.
    const mine = row({ brand_id: "brand-a", model_id: "m1", answers: 100, top3_rate: 0.5 });
    const theirs = row({ brand_id: "brand-b", model_id: "m2", answers: 100, top3_rate: 0.9 });
    const agg = aggregate([mine], [mine, theirs]);
    expect(agg.answers).toBe(200);
    expect(agg.top3_rate).toBeCloseTo(50 / 200, 6);
  });

  it("counts a row with no stored rate as no top-three answers", () => {
    // top3_rate is nullable. Zero, not NaN, and not skipped: the answers still
    // happened and still belong in the denominator.
    const rows = [
      row({ model_id: "m1", answers: 10, top3_rate: 5 / 10 }),
      row({ model_id: "m2", answers: 10, top3_rate: null }),
    ];
    expect(aggregate(rows).top3_rate).toBeCloseTo(5 / 20, 6);
  });

  it("is null rather than zero when nothing has been answered", () => {
    expect(aggregate([]).top3_rate).toBeNull();
    expect(aggregate([row({ answers: 0, top3_rate: null })]).top3_rate).toBeNull();
  });

  it("never exceeds mention rate, since a top-three answer is a mention", () => {
    const rows = [
      row({ model_id: "m1", answers: 150, mentions: 131, top3_rate: 0.4267 }),
      row({ model_id: "m2", answers: 150, mentions: 88, top3_rate: 0.1733 }),
    ];
    const agg = aggregate(rows);
    expect(agg.top3_rate!).toBeLessThanOrEqual(agg.mention_rate!);
  });
});

describe("sumAnswers", () => {
  it("counts a scope's answers once, however many brands were seen in it", () => {
    // Answers are duplicated across every brand row in a scope, so summing the
    // rows would multiply the denominator by the number of brands.
    const rows = [
      row({ brand_id: "brand-a", answers: 25 }),
      row({ brand_id: "brand-b", answers: 25 }),
      row({ brand_id: "brand-c", answers: 25 }),
    ];
    expect(sumAnswers(rows)).toBe(25);
  });

  it("treats each run, model and prompt as its own scope", () => {
    const rows = [
      row({ run_id: "r1", model_id: "m1", prompt_id: "p1", answers: 5 }),
      row({ run_id: "r1", model_id: "m1", prompt_id: "p2", answers: 5 }),
      row({ run_id: "r1", model_id: "m2", prompt_id: "p1", answers: 5 }),
      row({ run_id: "r2", model_id: "m1", prompt_id: "p1", answers: 5 }),
    ];
    expect(sumAnswers(rows)).toBe(20);
  });

  it("keeps a scope whose prompt has been deleted", () => {
    // Deleting a prompt deletes its tasks and its metric rows, so the server
    // does not send a per-prompt row with a null prompt. sumAnswers still
    // counts one as its own scope instead of dropping its answers.
    const rows = [row({ prompt_id: null, answers: 7 }), row({ prompt_id: "p1", answers: 3 })];
    expect(sumAnswers(rows)).toBe(10);
  });
});
