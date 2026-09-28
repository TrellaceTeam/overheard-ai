import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configuredProviders,
  hasAnyProviderKey,
  keyStatus,
  providerKeyValues,
  resolveProviderKey,
  UNUSABLE_KEY_MESSAGE,
} from "./keys";

const VARS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "OVERHEARD_MOCK_PROVIDERS",
];

function clear() {
  for (const name of VARS) delete process.env[name];
}

beforeEach(clear);
afterEach(clear);

describe("resolveProviderKey", () => {
  it("reads one variable per provider", () => {
    process.env["OPENAI_API_KEY"] = "sk-openai";
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-anthropic";
    process.env["GOOGLE_API_KEY"] = "AIza-google";
    expect(resolveProviderKey("openai")).toBe("sk-openai");
    expect(resolveProviderKey("anthropic")).toBe("sk-ant-anthropic");
    expect(resolveProviderKey("google")).toBe("AIza-google");
  });

  it("accepts GEMINI_API_KEY as the Google alias", () => {
    process.env["GEMINI_API_KEY"] = "AIza-gemini";
    expect(resolveProviderKey("google")).toBe("AIza-gemini");
  });

  it("prefers GOOGLE_API_KEY when both are set", () => {
    process.env["GOOGLE_API_KEY"] = "AIza-google";
    process.env["GEMINI_API_KEY"] = "AIza-gemini";
    expect(resolveProviderKey("google")).toBe("AIza-google");
  });

  it("is null when the variable is absent, empty or whitespace", () => {
    expect(resolveProviderKey("openai")).toBeNull();
    process.env["OPENAI_API_KEY"] = "";
    expect(resolveProviderKey("openai")).toBeNull();
    process.env["OPENAI_API_KEY"] = "   ";
    expect(resolveProviderKey("openai")).toBeNull();
  });

  it("trims, because a pasted key often arrives with a trailing newline", () => {
    process.env["OPENAI_API_KEY"] = "  sk-openai\n";
    expect(resolveProviderKey("openai")).toBe("sk-openai");
  });

  it("reads at call time, not at module scope", () => {
    expect(resolveProviderKey("openai")).toBeNull();
    process.env["OPENAI_API_KEY"] = "sk-late";
    expect(resolveProviderKey("openai")).toBe("sk-late");
  });
});

describe("configuredProviders", () => {
  it("lists only providers with a key", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-x";
    expect(configuredProviders()).toEqual(["anthropic"]);
    expect(hasAnyProviderKey()).toBe(true);
  });

  it("is empty with no keys at all", () => {
    expect(configuredProviders()).toEqual([]);
    expect(hasAnyProviderKey()).toBe(false);
  });
});

describe("keyStatus", () => {
  it("reports every provider as a boolean and nothing else", () => {
    process.env["OPENAI_API_KEY"] = "sk-openai-secret-value";
    const status = keyStatus();
    expect(status).toEqual([
      { provider: "openai", configured: true, source: "env", problem: null },
      { provider: "anthropic", configured: false, source: "none", problem: null },
      { provider: "google", configured: false, source: "none", problem: null },
    ]);
    // A screenshot of Settings leaks nothing.
    expect(JSON.stringify(status)).not.toContain("sk-openai-secret-value");
  });

  it("says mock, not key found, when the seam is what answers", () => {
    // The flow has to run keyless, so all three are callable, but the status
    // must not claim a key was found.
    process.env["OVERHEARD_MOCK_PROVIDERS"] = "1";
    expect(keyStatus().every((s) => s.configured)).toBe(true);
    expect(keyStatus().map((s) => s.source)).toEqual(["mock", "mock", "mock"]);
    expect(configuredProviders()).toEqual(["openai", "anthropic", "google"]);
  });

  it("refuses a key that cannot be an HTTP header, and never quotes it", () => {
    // Pasted from a web page or a PDF, a key can carry a zero-width space. Node
    // refuses the header and quotes the whole value back in a retryable error,
    // which would be stored, printed and shown on the dashboard.
    const bad = "AIzaSyAb12\u200bCd34EfGh56IjKl78MnOp90QrSt";
    process.env["GOOGLE_API_KEY"] = bad;

    expect(resolveProviderKey("google")).toBeNull();
    expect(configuredProviders()).toEqual([]);

    const google = keyStatus().find((s) => s.provider === "google");
    expect(google?.configured).toBe(false);
    expect(google?.problem).toBe(UNUSABLE_KEY_MESSAGE);
    expect(JSON.stringify(keyStatus())).not.toContain(bad);
  });

  it("offers every key value present, so a message can be scrubbed against it", () => {
    process.env["OPENAI_API_KEY"] = "sk-openai-secret-value";
    process.env["GOOGLE_API_KEY"] = "AIzaSyAb12\u200bCd34EfGh56IjKl78MnOp90QrSt";
    expect(providerKeyValues()).toEqual([
      "sk-openai-secret-value",
      "AIzaSyAb12\u200bCd34EfGh56IjKl78MnOp90QrSt",
    ]);
  });

  it("ignores a value too short to be a key, so a message is not shredded", () => {
    process.env["OPENAI_API_KEY"] = "x";
    expect(providerKeyValues()).toEqual([]);
  });
});
