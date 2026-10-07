import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Driver } from "../../db/driver";
import { freshDb, setProviderKeys } from "../../logic/test-support";
import { standInCommand } from "../../worker/cli-test-support";
import { clearAvailabilityCache, modelAvailability } from "./model-availability";

let db: Driver;
let restoreKeys: () => void = () => {};

beforeEach(() => {
  db = freshDb();
  clearAvailabilityCache();
  delete process.env["OVERHEARD_MOCK_PROVIDERS"];
});

afterEach(() => {
  restoreKeys();
  restoreKeys = () => {};
  delete process.env["OVERHEARD_MOCK_PROVIDERS"];
  delete process.env["OVERHEARD_ANTHROPIC_CLI"];
  delete process.env["OVERHEARD_OPENAI_CLI"];
  db.close();
});

function openaiList(ids: string[]) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("modelAvailability", () => {
  it("splits a key's catalogue models into available and missing", async () => {
    restoreKeys = setProviderKeys("OPENAI_API_KEY");
    const fetchImpl = openaiList(["gpt-6-sol", "gpt-6-luna", "some-model-we-do-not-offer"]);
    const report = await modelAvailability(db, { fetchImpl });

    const openai = report.openai;
    expect(openai.status).toBe("ok");
    if (openai.status !== "ok") return;
    expect(openai.available.sort()).toEqual(["gpt-6-luna", "gpt-6-sol"]);
    expect(openai.missing).toContain("gpt-6-astra");
    // A listed model the catalogue lacks is never offered.
    expect([...openai.available, ...openai.missing]).not.toContain("some-model-we-do-not-offer");
    expect(report.anthropic).toEqual({ status: "no_key" });
    expect(report.google).toEqual({ status: "no_key" });
  });

  it("reuses a recent list, and the Check button's force reads it again", async () => {
    restoreKeys = setProviderKeys("OPENAI_API_KEY");
    const fetchImpl = openaiList(["gpt-6-sol"]);
    await modelAvailability(db, { fetchImpl });
    await modelAvailability(db, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await modelAvailability(db, { fetchImpl, force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("says so plainly when the provider refuses the key, without repeating it", async () => {
    restoreKeys = setProviderKeys("OPENAI_API_KEY");
    const fetchImpl = vi.fn(
      async () => new Response("bad key", { status: 401 }),
    ) as unknown as typeof fetch;
    const report = await modelAvailability(db, { fetchImpl });
    expect(report.openai).toEqual({
      status: "error",
      message: "The provider refused this key, so its models could not be listed.",
    });
  });

  it("reads a ChatGPT plan's models through Codex, and says the list is the plan's", async () => {
    process.env["OVERHEARD_OPENAI_CLI"] = standInCommand(
      `process.stdout.write(JSON.stringify({ models: [{ slug: "gpt-6.1-sol" }, { slug: "gpt-6-luna" }, { slug: "assistant-alpha" }] }));`,
    );
    const report = await modelAvailability(db);
    const openai = report.openai;
    expect(openai.status === "ok" && openai.plan).toBe(true);
    if (openai.status !== "ok") return;
    expect(openai.available.sort()).toEqual(["gpt-6-luna", "gpt-6.1-sol"]);
    expect(openai.missing).toContain("gpt-6-astra");
  });

  it("offers every model when a plan's command has no list to read", async () => {
    process.env["OVERHEARD_ANTHROPIC_CLI"] = standInCommand();
    process.env["OVERHEARD_OPENAI_CLI"] = standInCommand(`process.stdout.write("not json");`);
    const report = await modelAvailability(db);
    expect(report.anthropic).toEqual({ status: "cli" });
    expect(report.openai).toEqual({ status: "cli" });
  });

  it("calls nothing under the mock seam", async () => {
    process.env["OVERHEARD_MOCK_PROVIDERS"] = "1";
    const fetchImpl = openaiList([]);
    const report = await modelAvailability(db, { fetchImpl });
    expect(report.openai).toEqual({ status: "mocked" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
