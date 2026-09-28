import { describe, expect, it, vi } from "vitest";
import { listedModel, listKeyModels } from "./model-list";

function respond(...bodies: unknown[]) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push({ url, headers: init?.headers ?? {} });
    const body = bodies[Math.min(seen.length - 1, bodies.length - 1)];
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, seen };
}

describe("listKeyModels", () => {
  it("reads OpenAI's list, with the key in the Authorization header only", async () => {
    const { fetchImpl, seen } = respond({ data: [{ id: "gpt-6-sol" }, { id: "gpt-6-luna" }] });
    expect(await listKeyModels("openai", "test-key", fetchImpl)).toEqual([
      "gpt-6-sol",
      "gpt-6-luna",
    ]);
    expect(seen[0]?.headers["authorization"]).toBe("Bearer test-key");
    expect(seen[0]?.url).not.toContain("test-key");
  });

  it("pages through Anthropic's list", async () => {
    const { fetchImpl, seen } = respond(
      { data: [{ id: "claude-opus-5-5" }], has_more: true, last_id: "claude-opus-5-5" },
      { data: [{ id: "claude-haiku-4-5-20251001" }], has_more: false },
    );
    expect(await listKeyModels("anthropic", "test-key", fetchImpl)).toEqual([
      "claude-opus-5-5",
      "claude-haiku-4-5-20251001",
    ]);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.url).toContain("after_id=claude-opus-5-5");
    expect(seen[0]?.headers["x-api-key"]).toBe("test-key");
  });

  it("pages through Gemini's list and drops the models/ prefix, keeping the key out of the URL", async () => {
    const { fetchImpl, seen } = respond(
      { models: [{ name: "models/gemini-3.8-flash" }], nextPageToken: "next" },
      { models: [{ name: "models/gemini-3.5-flash-lite" }] },
    );
    expect(await listKeyModels("google", "test-key", fetchImpl)).toEqual([
      "gemini-3.8-flash",
      "gemini-3.5-flash-lite",
    ]);
    expect(seen[1]?.url).toContain("pageToken=next");
    expect(seen.every((call) => !call.url.includes("test-key"))).toBe(true);
    expect(seen[0]?.headers["x-goog-api-key"]).toBe("test-key");
  });

  it("fails with the status, never the key, on a refused request", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("invalid api key test-key", { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(listKeyModels("openai", "test-key", fetchImpl)).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe("listedModel", () => {
  const listed = new Set(["claude-haiku-4-5-20251001", "gpt-6-sol", "gpt-6-sol-mini"]);

  it("matches an exact id", () => {
    expect(listedModel("gpt-6-sol", listed)).toBe(true);
  });

  it("matches a dated snapshot of an undated catalogue id", () => {
    expect(listedModel("claude-haiku-4-5", listed)).toBe(true);
  });

  it("does not take a different model with the same prefix for this one", () => {
    expect(listedModel("gpt-6", listed)).toBe(false);
    expect(listedModel("claude-opus-5-5", listed)).toBe(false);
  });
});
