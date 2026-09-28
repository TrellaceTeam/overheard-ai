/**
 * Re-reading provider keys from .env while the app runs. Every test writes its
 * own file in a temporary folder and restores the variables it touched.
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseEnvFile, refreshEnvKeys, unwatchEnvFile, watchEnvFile } from "./env-file";
import { keyStatus, resolveProviderKey } from "./keys";

const TOUCHED = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "DATABASE_PATH",
  "OVERHEARD_MOCK_PROVIDERS",
];

let dir: string;
let file: string;
let saved: Record<string, string | undefined>;
let clock = Date.parse("2026-09-28T00:00:00Z");

/** Writes the file with a fresh mtime, so a same-size edit is still seen. */
function write(text: string): void {
  writeFileSync(file, text);
  clock += 10_000;
  utimesSync(file, clock / 1000, clock / 1000);
}

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((name) => [name, process.env[name]]));
  for (const name of TOUCHED) delete process.env[name];
  dir = mkdtempSync(join(tmpdir(), "overheard-env-"));
  file = join(dir, ".env");
});

afterEach(() => {
  unwatchEnvFile();
  for (const name of TOUCHED) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("parseEnvFile", () => {
  it("reads the dotenv lines a key uses", () => {
    const values = parseEnvFile(
      [
        "# comment",
        "",
        "OPENAI_API_KEY=sk-plain",
        "export ANTHROPIC_API_KEY = sk-ant-exported ",
        'GOOGLE_API_KEY="AIza-quoted # not a comment"',
        "GEMINI_API_KEY='single'",
        "PORT=3000 # the port",
        "EMPTY=",
        "not a line",
      ].join("\r\n"),
    );
    expect(values.get("OPENAI_API_KEY")).toBe("sk-plain");
    expect(values.get("ANTHROPIC_API_KEY")).toBe("sk-ant-exported");
    expect(values.get("GOOGLE_API_KEY")).toBe("AIza-quoted # not a comment");
    expect(values.get("GEMINI_API_KEY")).toBe("single");
    expect(values.get("PORT")).toBe("3000");
    expect(values.get("EMPTY")).toBe("");
    expect(values.size).toBe(6);
  });
});

describe("watching .env", () => {
  it("does nothing until boot names the file", () => {
    write("OPENAI_API_KEY=sk-from-file\n");
    refreshEnvKeys();
    expect(process.env["OPENAI_API_KEY"]).toBeUndefined();
  });

  it("picks up a key added after start, with no restart", () => {
    write("OPENAI_API_KEY=\n");
    watchEnvFile(file);
    expect(resolveProviderKey("openai")).toBeNull();

    write("OPENAI_API_KEY=sk-added-later\n");
    expect(resolveProviderKey("openai")).toBe("sk-added-later");
    expect(keyStatus().find((row) => row.provider === "openai")?.configured).toBe(true);
  });

  it("applies an edit made between process start and boot", () => {
    // Under `vite dev` the app boots on the first request, after the process
    // loaded .env.
    process.env["OPENAI_API_KEY"] = "";
    write("OPENAI_API_KEY=sk-edited-before-boot\n");
    watchEnvFile(file);
    expect(resolveProviderKey("openai")).toBe("sk-edited-before-boot");
  });

  it("drops a key removed from the file", () => {
    write("ANTHROPIC_API_KEY=sk-ant-one\n");
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-one";
    watchEnvFile(file);
    expect(resolveProviderKey("anthropic")).toBe("sk-ant-one");

    write("# gone\n");
    expect(resolveProviderKey("anthropic")).toBeNull();
  });

  it("never overrides a key the shell set", () => {
    process.env["OPENAI_API_KEY"] = "sk-from-shell";
    write("OPENAI_API_KEY=sk-in-file\n");
    watchEnvFile(file);
    expect(resolveProviderKey("openai")).toBe("sk-from-shell");

    write("OPENAI_API_KEY=sk-edited-file\n");
    expect(resolveProviderKey("openai")).toBe("sk-from-shell");
  });

  it("re-reads provider keys only, never the database path or the mock seam", () => {
    write("DATABASE_PATH=./other.db\nOVERHEARD_MOCK_PROVIDERS=1\n");
    watchEnvFile(file);
    refreshEnvKeys();
    expect(process.env["DATABASE_PATH"]).toBeUndefined();
    expect(process.env["OVERHEARD_MOCK_PROVIDERS"]).toBeUndefined();
  });

  it("forgets every file key when the file is deleted", () => {
    write("GOOGLE_API_KEY=AIza-file\n");
    watchEnvFile(file);
    expect(resolveProviderKey("google")).toBe("AIza-file");

    rmSync(file);
    expect(resolveProviderKey("google")).toBeNull();
  });
});
