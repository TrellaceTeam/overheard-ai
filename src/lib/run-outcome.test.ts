import { describe, expect, it } from "vitest";
import { runOutcome, taskState } from "./run-outcome";
import { CALLS_PER_ANSWER } from "./run-progress";

/** Runs store provider calls; a person reads answers. Build inputs in answers. */
const calls = (answers: number) => answers * CALLS_PER_ANSWER;

describe("runOutcome", () => {
  it("gives every status a headline and a consequence, including unknown ones", () => {
    // Rendering run.status directly would put PARTIAL on screen. A status
    // added to the enum later must not appear as a token either.
    for (const status of [
      "queued",
      "running",
      "completed",
      "partial",
      "failed",
      "cancelled",
      "some_status_nobody_has_written_yet",
    ]) {
      const { headline, detail } = runOutcome(status, calls(3), 0, calls(10));
      expect(headline.length).toBeGreaterThan(0);
      // The consequence is a count of answers, so every line carries a number.
      expect(detail).toMatch(/\d/);
      expect(detail).toMatch(/answer/);
    }
  });

  it("does not surface the enum tokens that mean nothing to a user", () => {
    // "Queued" is the right English word for `queued`, so the test is about
    // jargon, not about the token never appearing. `partial` misleads: it
    // reads as "still going" when work has stopped. An unrecognised token must
    // never be echoed at all.
    expect(runOutcome("partial", calls(7), calls(3), calls(10)).headline).not.toMatch(/partial/i);
    expect(
      runOutcome("some_status_nobody_has_written_yet", calls(3), 0, calls(10)).headline,
    ).not.toMatch(/some_status/i);
  });

  it("reads as finished for every terminal status, and as unfinished otherwise", () => {
    for (const status of ["completed", "partial", "failed", "cancelled"]) {
      expect(runOutcome(status, calls(5), 0, calls(5)).finished).toBe(true);
    }
    for (const status of ["queued", "running"]) {
      expect(runOutcome(status, calls(1), 0, calls(5)).finished).toBe(false);
    }
  });

  it("distinguishes wholly successful, partly failed and wholly failed", () => {
    const success = runOutcome("completed", calls(10), 0, calls(10));
    const partial = runOutcome("partial", calls(7), calls(3), calls(10));
    const failed = runOutcome("failed", 0, calls(10), calls(10));

    // What matters is that they read differently, so assert on the text a
    // person sees, not only on the tone token driving the colour.
    const texts = [success, partial, failed].map((o) => `${o.headline} ${o.detail}`);
    expect(new Set(texts).size).toBe(3);

    expect(success.tone).toBe("success");
    expect(partial.tone).toBe("partial");
    expect(failed.tone).toBe("failed");
  });

  it("says failed, not 'did not arrive', because an answer can fail after arriving", () => {
    // A task that dies while being scored holds its answer, and its row says
    // "arrived but was never scored". A finished line claiming it never
    // arrived would contradict that row. The in-flight, partial and
    // wholly-failed lines all say "failed".
    const { detail } = runOutcome("partial", calls(7), calls(3), calls(10));
    expect(detail).toBe("7 of 10 answers collected. 3 failed.");
    expect(detail).not.toMatch(/did not arrive/);
  });

  it("states the consequence, not just the outcome", () => {
    // A headline alone does not tell someone 3 of their 10 answers are missing.
    const partial = runOutcome("partial", calls(7), calls(3), calls(10));
    expect(partial.detail).toContain("7");
    expect(partial.detail).toContain("3");
  });

  it("tells a cancelled run apart from a failed one", () => {
    const cancelled = runOutcome("cancelled", calls(4), 0, calls(10));
    const failed = runOutcome("failed", 0, calls(10), calls(10));
    expect(cancelled.headline).not.toBe(failed.headline);
    expect(cancelled.tone).not.toBe(failed.tone);
    // A cancelled run kept the answers it had already collected, and saying so
    // is the difference between "you stopped it" and "it lost your work".
    expect(cancelled.detail).toContain("4");
  });

  it("counts in answers, never in provider calls", () => {
    // Ten answers cost twenty calls. Showing 20 reads as a bug in the app.
    const { detail } = runOutcome("completed", calls(10), 0, calls(10));
    expect(detail).toContain("10");
    expect(detail).not.toContain("20");
  });

  it("speaks in the singular for a one-answer run", () => {
    const { detail } = runOutcome("completed", calls(1), 0, calls(1));
    expect(detail).toContain("1 answer");
    expect(detail).not.toContain("1 answers");
  });

  it("survives the nulls the row types allow", () => {
    const { headline, detail, finished } = runOutcome(null, null, null, null);
    expect(headline.length).toBeGreaterThan(0);
    expect(detail.length).toBeGreaterThan(0);
    expect(finished).toBe(false);
  });

  it("does not claim a run is complete when the numbers say otherwise", () => {
    // updateRunProgress should never produce this, but a status of completed
    // with answers missing must not read as "all 10 collected".
    const { detail } = runOutcome("completed", calls(7), 0, calls(10));
    expect(detail).toContain("7");
    expect(detail).not.toMatch(/all 10/i);
  });
});

describe("runOutcome, the pending breakdown", () => {
  const pending = { fresh: 3, retrying: 12, working: 5 };

  it("reconciles every bucket in one sentence that sums to the plan", () => {
    const { detail } = runOutcome("running", calls(55), calls(4), calls(79), {
      fresh: 3,
      retrying: 12,
      working: 5,
    });
    expect(detail).toBe(
      "55 of 79 answers collected so far: 8 still to come back, 12 being retried, 4 failed.",
    );
  });

  it("omits empty buckets rather than listing zeroes", () => {
    const { detail } = runOutcome("running", calls(8), 0, calls(10), {
      fresh: 2,
      retrying: 0,
      working: 0,
    });
    expect(detail).toBe("8 of 10 answers collected so far: 2 still to come back.");
    expect(detail).not.toContain("retried");
    expect(detail).not.toContain("failed");
  });

  it("says when the only work left is the retry", () => {
    const { headline, detail } = runOutcome("running", calls(6), calls(2), calls(10), {
      fresh: 0,
      retrying: 2,
      working: 0,
    });
    expect(headline).toBe("Running retry");
    expect(detail).toBe("6 of 10 answers collected so far: 2 being retried, 2 failed.");
  });

  it("stays plain Running while fresh work is outstanding", () => {
    const { headline } = runOutcome("running", calls(6), 0, calls(10), pending);
    expect(headline).toBe("Running");
  });

  it("keeps the counters-only sentence when no breakdown is passed", () => {
    // The dashboard's run list has stored counters, not a live recount.
    const { detail } = runOutcome("running", calls(6), calls(2), calls(10));
    expect(detail).toBe("6 of 10 answers collected so far. 2 have failed.");
  });

  it("never shows a negative collected count", () => {
    const { detail } = runOutcome("running", 0, calls(4), calls(10), {
      fresh: 10,
      retrying: 2,
      working: 1,
    });
    expect(detail).toMatch(/^0 of 10 answers collected so far/);
  });
});

describe("taskState", () => {
  it("says what is happening, in words, for every real status", () => {
    expect(taskState("queued").label).toBe("Queued");
    expect(taskState("in_flight").label).toBe("Waiting for a response");
    expect(taskState("answered").label).toBe("Response received");
    expect(taskState("extracting").label).toBe("Reading the answer");
    expect(taskState("done").label).toBe("Done");
    expect(taskState("failed").label).toBe("Failed");
  });

  it("never renders the status token itself", () => {
    // Same rule runOutcome follows: a status name is a word about our state
    // machine, not about the user's run.
    for (const status of ["in_flight", "extracting", "some_future_state", "", null, undefined]) {
      expect(taskState(status).label).not.toContain("_");
      expect(taskState(status).label[0]).toBe(taskState(status).label[0]?.toUpperCase());
    }
  });

  it("treats an unknown status as working rather than guessing", () => {
    expect(taskState("some_future_state")).toEqual({ label: "Working", tone: "running" });
    expect(taskState(undefined).label).toBe("Working");
  });

  it("tones a finished task apart from a failed one", () => {
    expect(taskState("done").tone).toBe("success");
    expect(taskState("failed").tone).toBe("failed");
    expect(taskState("blocked").tone).toBe("failed");
    expect(taskState("queued").tone).toBe("waiting");
  });
});
