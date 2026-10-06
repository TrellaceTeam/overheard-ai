import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  callCli,
  type CliCall,
  claudeArgs,
  classifyCliFailure,
  codexArgs,
  readClaude,
  readCodex,
  runProcess,
} from "./cli-provider";
import { EXTRACTION_SHAPE } from "./extraction";

const lines = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");

function call(overrides: Partial<CliCall> = {}): CliCall {
  return {
    target: { provider: "anthropic", command: "claude" },
    modelId: "assistant-alpha",
    system: "Answer as you would for any buyer.",
    user: "Which analytics tools should a small team shortlist?",
    jsonMode: false,
    webSearch: true,
    timeoutMs: 10_000,
    ...overrides,
  };
}

const FILES = { instructions: join("work", "instructions.md"), schema: null };

/** A stand-in tool: a script run by this test's own JS runtime. */
function standIn(source: string): { file: string; prefix: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "overheard-stand-in-"));
  const script = join(dir, "tool.cjs");
  writeFileSync(script, source);
  return { file: process.execPath, prefix: [script] };
}

describe("readClaude", () => {
  const searchUse = {
    type: "assistant",
    message: {
      model: "claude-model-x",
      content: [{ type: "tool_use", id: "t1", name: "WebSearch", input: { query: "analytics" } }],
    },
  };

  it("reads the answer, the searches that came back and the model that answered", () => {
    const reading = readClaude(
      lines([
        { type: "system", subtype: "init" },
        searchUse,
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } },
        {
          type: "result",
          is_error: false,
          result: "1. Acme Analytics (https://acme.example.com)\n2. Northwind Metrics",
          stop_reason: "end_turn",
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 3000,
            output_tokens: 400,
          },
        },
      ]),
    );
    expect(reading).toEqual({
      ok: true,
      result: {
        text: "1. Acme Analytics (https://acme.example.com)\n2. Northwind Metrics",
        inputTokens: 3210,
        outputTokens: 400,
        tokens: 3610,
        searchCalls: 1,
        stopReason: "end_turn",
        truncated: false,
        model: "claude-model-x",
      },
    });
  });

  it("does not count a search that came back as an error", () => {
    const reading = readClaude(
      lines([
        searchUse,
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true }] },
        },
        { type: "result", is_error: false, result: "From memory: Acme Analytics." },
      ]),
    );
    expect(reading.ok && reading.result.searchCalls).toBe(0);
  });

  it("returns the enforced shape as JSON text, the way every adapter does", () => {
    const reading = readClaude(
      lines([
        {
          type: "result",
          is_error: false,
          result: "",
          structured_output: { answer_format: "prose", total_items: 0, brands: [] },
        },
      ]),
    );
    expect(reading.ok && reading.result.text).toBe(
      '{"answer_format":"prose","total_items":0,"brands":[]}',
    );
  });

  it("passes on the tool's own words when the call failed", () => {
    const reading = readClaude(
      lines([
        {
          type: "result",
          is_error: true,
          result: "Not logged in · Please run /login",
          api_error_status: null,
        },
      ]),
    );
    expect(reading).toEqual({
      ok: false,
      message: "Not logged in · Please run /login",
      status: null,
    });
  });

  it("fails a run that printed no result, such as a killed process", () => {
    expect(readClaude('{"type":"system","subtype":"init"}\n{"type":"assis')).toEqual({
      ok: false,
      message: "",
      status: null,
    });
  });
});

describe("readCodex", () => {
  it("takes the last agent message as the answer and counts every completed search", () => {
    const reading = readCodex(
      lines([
        { type: "thread.started", thread_id: "thread-1" },
        { type: "turn.started" },
        { type: "item.completed", item: { type: "error", message: "Exceeded skills budget." } },
        { type: "item.started", item: { type: "web_search", action: { type: "other" } } },
        { type: "item.completed", item: { type: "web_search", action: { type: "search" } } },
        { type: "item.completed", item: { type: "agent_message", text: "Checking one more." } },
        { type: "item.completed", item: { type: "web_search", action: { type: "search" } } },
        {
          type: "item.completed",
          item: {
            type: "agent_message",
            text: "Start with Acme Analytics (https://acme.example.com).",
          },
        },
        { type: "turn.completed", usage: { input_tokens: 16_000, output_tokens: 500 } },
      ]),
    );
    expect(reading).toEqual({
      ok: true,
      result: {
        text: "Start with Acme Analytics (https://acme.example.com).",
        inputTokens: 16_000,
        outputTokens: 500,
        tokens: 16_500,
        searchCalls: 2,
      },
    });
  });

  it("reads the status a failed turn quotes from the provider", () => {
    const signedOut = readCodex(
      lines([
        { type: "error", message: "Reconnecting... 1/5 (unexpected status 401 Unauthorized)" },
        {
          type: "turn.failed",
          error: { message: "unexpected status 401 Unauthorized: Missing bearer authentication" },
        },
      ]),
    );
    expect(signedOut).toEqual({
      ok: false,
      message: "unexpected status 401 Unauthorized: Missing bearer authentication",
      status: 401,
    });

    const refused = readCodex(
      lines([
        {
          type: "turn.failed",
          error: {
            message:
              '{"type":"error","status":400,"error":{"message":"The \'assistant-alpha\' model is not supported."}}',
          },
        },
      ]),
    );
    expect(!refused.ok && refused.status).toBe(400);
  });

  it("fails a run that never finished its turn, with the last error it printed", () => {
    expect(
      readCodex(lines([{ type: "turn.started" }, { type: "error", message: "stream closed" }])),
    ).toEqual({
      ok: false,
      message: "stream closed",
      status: null,
    });
  });
});

describe("classifyCliFailure", () => {
  it("sorts the tools' messages by what the user can do", () => {
    expect(classifyCliFailure("Not logged in · Please run /login", null).kind).toBe("sign_in");
    expect(classifyCliFailure("unexpected status 401 Unauthorized", 401).kind).toBe("sign_in");
    expect(
      classifyCliFailure("Your refresh token has expired. Please sign in again.", null).kind,
    ).toBe("sign_in");
    expect(classifyCliFailure("You've hit your usage limit. Try again at 3pm.", null).kind).toBe(
      "plan_limit",
    );
    expect(classifyCliFailure("5-hour limit reached · resets 3pm", null).kind).toBe("plan_limit");
    expect(classifyCliFailure("model is not supported", 400)).toEqual({
      kind: "refused",
      status: 400,
      message: "model is not supported",
    });
    expect(classifyCliFailure("error: unknown option '--safe-mode'", null)).toEqual({
      kind: "failed",
      message: "error: unknown option '--safe-mode'",
    });
  });
});

describe("claudeArgs", () => {
  it("never puts the question or the instructions on the command line", () => {
    const args = claudeArgs(call(), FILES);
    expect(args.join(" ")).not.toContain("buyer");
    expect(args.join(" ")).not.toContain("shortlist");
    expect(args[args.indexOf("--system-prompt-file") + 1]).toBe(FILES.instructions);
  });

  it("offers web search only to an answer, and every tool is off otherwise", () => {
    const answer = claudeArgs(call(), FILES);
    expect(answer[answer.indexOf("--tools") + 1]).toBe("WebSearch");
    const extraction = claudeArgs(call({ webSearch: false, jsonMode: true }), FILES);
    expect(extraction[extraction.indexOf("--tools") + 1]).toBe("");
  });

  it("sends the enforced shape inline as JSON", () => {
    const args = claudeArgs(
      call({ webSearch: false, jsonMode: true, jsonSchema: EXTRACTION_SHAPE }),
      FILES,
    );
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1] ?? "")).toEqual(
      EXTRACTION_SHAPE.schema,
    );
  });
});

describe("codexArgs", () => {
  const openai = { provider: "openai" as const, command: "codex" };

  it("reads the question from stdin and the instructions from a file TOML can read", () => {
    const args = codexArgs(call({ target: openai }), {
      instructions: "C:\\Temp\\run 1\\instructions.md",
      schema: null,
    });
    expect(args.slice(0, 2)).toEqual(["exec", "-"]);
    expect(args).toContain('model_instructions_file="C:\\\\Temp\\\\run 1\\\\instructions.md"');
    expect(args.join(" ")).not.toContain("shortlist");
  });

  it("searches the live web on an answer and not at all on an extraction", () => {
    expect(codexArgs(call({ target: openai }), FILES)).toContain('web_search="live"');
    const extraction = codexArgs(call({ target: openai, webSearch: false, jsonMode: true }), {
      ...FILES,
      schema: "schema.json",
    });
    expect(extraction).toContain('web_search="disabled"');
    expect(extraction[extraction.indexOf("--output-schema") + 1]).toBe("schema.json");
  });

  it("switches features off in a form every Codex version accepts", () => {
    // --disable rejects a feature name the installed version does not know.
    const args = codexArgs(call({ target: openai }), FILES);
    expect(args).not.toContain("--disable");
    expect(args).toContain("features.shell_tool=false");
  });
});

describe("runProcess", () => {
  it("hands the input to the tool on stdin and returns what it printed", async () => {
    const exit = await runProcess(standIn("process.stdin.pipe(process.stdout);"), [], {
      cwd: tmpdir(),
      env: process.env,
      stdin: "Which analytics tools?",
      timeoutMs: 20_000,
    });
    expect(exit.stdout).toBe("Which analytics tools?");
    expect(exit.timedOut).toBe(false);
  });

  it("stops a tool that runs past its deadline", async () => {
    const started = Date.now();
    const exit = await runProcess(standIn("setInterval(() => {}, 1000);"), [], {
      cwd: tmpdir(),
      env: process.env,
      stdin: "",
      timeoutMs: 500,
    });
    expect(exit.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("reports a program that cannot be started", async () => {
    const exit = await runProcess(
      { file: join(tmpdir(), "no-such-program-here"), prefix: [] },
      [],
      {
        cwd: tmpdir(),
        env: process.env,
        stdin: "",
        timeoutMs: 5_000,
      },
    );
    expect(exit.startError).not.toBeNull();
  });
});

describe("callCli", () => {
  afterEach(() => {
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["FAKE_TOOL_OUTPUT"];
  });

  /**
   * Stands in for Claude Code: reads what a real one would, and answers with
   * what it saw, so the test can check what the tool was given.
   */
  const CLAUDE_STAND_IN = `
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const seen = {
    input,
    system: fs.readFileSync(args[args.indexOf("--system-prompt-file") + 1], "utf8"),
    apiKey: process.env.ANTHROPIC_API_KEY ?? null,
    folder: fs.readdirSync(process.cwd()),
  };
  const events = [
    { type: "assistant", message: { model: "claude-model-x", content: [{ type: "tool_use", id: "t1", name: "WebSearch" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } },
    { type: "result", is_error: false, result: JSON.stringify(seen), usage: { input_tokens: 5, output_tokens: 7 } },
  ];
  process.stdout.write(events.map((event) => JSON.stringify(event)).join("\\n") + "\\n");
});`;

  it("asks from an empty folder, with no API key and the prompt on stdin", async () => {
    // Claude Code would bill this key at API rates ahead of the plan.
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-must-not-reach-the-tool";
    const outcome = await callCli(call(), standIn(CLAUDE_STAND_IN));
    if (!outcome.ok) throw new Error(`stand-in failed: ${outcome.failure.message}`);
    expect(JSON.parse(outcome.result.text)).toEqual({
      input: "Which analytics tools should a small team shortlist?",
      system: "Answer as you would for any buyer.",
      apiKey: null,
      folder: ["instructions.md"],
    });
    expect(outcome.result.searchCalls).toBe(1);
    expect(outcome.result.model).toBe("claude-model-x");
  });

  it("sorts a failed turn by what the user can do", async () => {
    process.env["FAKE_TOOL_OUTPUT"] = lines([
      { type: "turn.failed", error: { message: "unexpected status 401 Unauthorized" } },
    ]);
    const outcome = await callCli(
      call({ target: { provider: "openai", command: "codex" } }),
      standIn("process.stdout.write(process.env.FAKE_TOOL_OUTPUT);"),
    );
    expect(outcome).toEqual({
      ok: false,
      failure: { kind: "sign_in", message: "unexpected status 401 Unauthorized" },
    });
  });

  it("names the variable to set when the command cannot be found", async () => {
    const outcome = await callCli(
      call({ target: { provider: "anthropic", command: "overheard-no-such-command" } }),
    );
    expect(outcome).toEqual({
      ok: false,
      failure: {
        kind: "sign_in",
        message:
          'Overheard AI cannot find "overheard-no-such-command". Install Claude Code and sign in to it, or set OVERHEARD_ANTHROPIC_CLI to the command\'s full path.',
      },
    });
  });
});
