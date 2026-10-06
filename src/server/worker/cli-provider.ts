/**
 * Subscription mode's adapter. A call goes to the provider's own command line
 * tool, signed in with the user's plan, instead of to the provider's API:
 * Claude Code (`claude -p`) for Anthropic and Codex (`codex exec`) for OpenAI.
 *
 * Every call is a fresh process in a fresh, empty temporary folder, so no call
 * sees another's answer, a saved session or the files around the app. The
 * question goes in on stdin and the instructions in a file, and no shell
 * starts the process (see cli-command.ts), so no prompt text is ever parsed as
 * an argument.
 *
 * Both tools are coding agents and bring context of their own. The arguments
 * below remove what each lets a caller remove: the user's settings,
 * instructions, memory, skills, plugins and every tool but web search.
 * docs/decisions/0007-subscription-mode.md lists what remains.
 *
 * This module returns what happened as data. providers.ts turns a failure
 * into the ProviderError the worker records.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDER_CLI, PROVIDER_KEY_ENV } from "@/lib/provider-keys";
import { type Launch, type LaunchLookup, launchProblem, lookupLaunch } from "./cli-command";
import type { EnforcedShape } from "./extraction";
import type { CliTarget } from "./keys";
import type { ProviderResult } from "./providers";

export interface CliCall {
  target: CliTarget;
  modelId: string;
  system: string;
  user: string;
  /** A JSON reply. Turns thinking off on Claude, where it otherwise takes over a minute. */
  jsonMode: boolean;
  jsonSchema?: EnforcedShape | undefined;
  webSearch: boolean;
  timeoutMs: number;
}

/**
 * Why a call failed, sorted by what the user can do about it. `refused` is the
 * provider's own HTTP refusal, passed through by the tool.
 */
export type CliFailure =
  | { kind: "sign_in"; message: string }
  | { kind: "plan_limit"; message: string }
  | { kind: "timeout"; message: string }
  | { kind: "refused"; status: number; message: string }
  | { kind: "failed"; message: string };

export type CliOutcome = { ok: true; result: ProviderResult } | { ok: false; failure: CliFailure };

/** What a tool's output says, before the exit is judged. */
export type CliReading =
  | { ok: true; result: ProviderResult }
  | { ok: false; message: string; status: number | null };

/**
 * Removed from the tool's environment. Claude Code uses ANTHROPIC_API_KEY
 * ahead of the plan sign-in and bills it at API rates, and Codex does the
 * same with CODEX_API_KEY. The other providers' keys are no business of
 * either tool.
 */
const KEY_VARIABLES = [
  ...Object.values(PROVIDER_KEY_ENV).flat(),
  "ANTHROPIC_AUTH_TOKEN",
  "CODEX_API_KEY",
];

/**
 * Codex features that add tools or instructions a question does not need.
 * Written as `features.<name>=false` and not `--disable <name>`, because
 * `--disable` rejects a name the installed version does not know, and the
 * list differs between versions.
 */
const CODEX_FEATURES_OFF = [
  "multi_agent",
  "apps",
  "plugins",
  "remote_plugin",
  "shell_tool",
  "unified_exec",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "image_generation",
  "tool_suggest",
  "goals",
  "skill_search",
  "in_app_browser",
  "workspace_dependencies",
  "memories",
  "hooks",
  "realtime_conversation",
];

interface CallFiles {
  instructions: string;
  /** Codex reads the enforced shape from a file. Claude Code takes it inline. */
  schema: string | null;
}

/**
 * `--safe-mode` drops CLAUDE.md, skills, plugins, hooks and MCP servers and
 * keeps the plan sign-in. `--system-prompt-file` replaces Claude Code's own
 * system prompt. Low effort matches the API path's answers.
 */
export function claudeArgs(call: CliCall, files: CallFiles): string[] {
  return [
    "-p",
    "--safe-mode",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    call.modelId,
    "--system-prompt-file",
    files.instructions,
    ...(call.webSearch
      ? ["--tools", "WebSearch", "--allowedTools", "WebSearch", "--effort", "low"]
      : ["--tools", ""]),
    ...(call.jsonSchema ? ["--json-schema", JSON.stringify(call.jsonSchema.schema)] : []),
  ];
}

/**
 * `model_instructions_file` replaces Codex's own instructions. The project
 * instructions limit, the skills budget and the features list remove the rest
 * Codex lets a caller remove. Codex searches a cached index unless search is
 * set to live. A path goes in as a JSON string, which TOML reads the same way.
 */
export function codexArgs(call: CliCall, files: CallFiles): string[] {
  return [
    "exec",
    "-",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--sandbox",
    "read-only",
    "-m",
    call.modelId,
    "-c",
    `model_instructions_file=${JSON.stringify(files.instructions)}`,
    "-c",
    "project_doc_max_bytes=1",
    "-c",
    // The smallest budget Codex accepts. It leaves the skills list empty.
    "skills.max_context_tokens=1",
    "-c",
    "agents.enabled=false",
    ...CODEX_FEATURES_OFF.flatMap((feature) => ["-c", `features.${feature}=false`]),
    "-c",
    call.webSearch ? 'web_search="live"' : 'web_search="disabled"',
    ...(call.webSearch ? ["-c", 'model_reasoning_effort="low"'] : []),
    ...(files.schema ? ["--output-schema", files.schema] : []),
  ];
}

function cliEnv(call: CliCall): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of KEY_VARIABLES) delete env[name];
  if (call.target.provider === "anthropic") {
    // Many processes at once must not each try to update the binary they run from.
    env["DISABLE_AUTOUPDATER"] = "1";
    if (call.jsonMode) env["MAX_THINKING_TOKENS"] = "0";
  }
  return env;
}

function jsonLines<T>(stdout: string): T[] {
  const events: T[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      events.push(JSON.parse(line) as T);
    } catch {
      // A partial last line from a killed process.
    }
  }
  return events;
}

function totalOf(input: number | null, output: number | null): number | null {
  return input === null && output === null ? null : (input ?? 0) + (output ?? 0);
}

type ClaudeBlock = {
  type?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  is_error?: boolean;
};

type ClaudeEvent = {
  type?: string;
  message?: { model?: string; content?: ClaudeBlock[] };
  result?: string;
  is_error?: boolean;
  stop_reason?: string | null;
  structured_output?: unknown;
  api_error_status?: number | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

/**
 * Reads `claude -p --output-format stream-json`. The last event is the
 * result. A search counts when its WebSearch call came back without an error.
 * Input tokens include cached ones, which Claude Code reports apart.
 */
export function readClaude(stdout: string): CliReading {
  const events = jsonLines<ClaudeEvent>(stdout);
  const result = events.filter((event) => event.type === "result").at(-1);
  if (!result) return { ok: false, message: "", status: null };
  if (result.is_error) {
    return { ok: false, message: result.result ?? "", status: result.api_error_status ?? null };
  }
  const blocks = (type: string) =>
    events.filter((event) => event.type === type).flatMap((event) => event.message?.content ?? []);
  const searches = new Set(
    blocks("assistant")
      .filter((block) => block.type === "tool_use" && block.name === "WebSearch")
      .map((block) => block.id),
  );
  const searchCalls = blocks("user").filter(
    (block) =>
      block.type === "tool_result" && searches.has(block.tool_use_id) && block.is_error !== true,
  ).length;
  const usage = result.usage;
  const inputTokens = usage
    ? (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0)
    : null;
  const outputTokens = usage?.output_tokens ?? null;
  const shaped = result.structured_output;
  return {
    ok: true,
    result: {
      text:
        shaped !== undefined && shaped !== null ? JSON.stringify(shaped) : (result.result ?? ""),
      inputTokens,
      outputTokens,
      tokens: totalOf(inputTokens, outputTokens),
      searchCalls,
      stopReason: result.stop_reason ?? undefined,
      truncated: result.stop_reason === "max_tokens",
      model: events.find((event) => event.type === "assistant" && event.message?.model)?.message
        ?.model,
    },
  };
}

type CodexEvent = {
  type?: string;
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
  message?: string;
};

/** The HTTP status a tool quotes from the provider, as `status 401` or `"status":400`. */
function quotedStatus(message: string): number | null {
  const match = /\bstatus"?\s*:?\s*([45]\d\d)\b/.exec(message);
  return match?.[1] ? Number(match[1]) : null;
}

/**
 * Reads `codex exec --json`. A turn ends in turn.completed or turn.failed.
 * `error` events before that are retries Codex recovers from, and an `error`
 * item is a notice, such as the skills budget at work. The answer is the last
 * agent message, after any the model wrote between searches.
 */
export function readCodex(stdout: string): CliReading {
  const events = jsonLines<CodexEvent>(stdout);
  const failed = events.find((event) => event.type === "turn.failed");
  const completed = events.find((event) => event.type === "turn.completed");
  if (failed || !completed) {
    const message =
      failed?.error?.message ??
      events.filter((event) => event.type === "error").at(-1)?.message ??
      "";
    return { ok: false, message, status: quotedStatus(message) };
  }
  const items = events
    .filter((event) => event.type === "item.completed")
    .map((event) => event.item ?? {});
  const inputTokens = completed.usage?.input_tokens ?? null;
  const outputTokens = completed.usage?.output_tokens ?? null;
  return {
    ok: true,
    result: {
      text: items.filter((item) => item.type === "agent_message").at(-1)?.text ?? "",
      inputTokens,
      outputTokens,
      tokens: totalOf(inputTokens, outputTokens),
      searchCalls: items.filter((item) => item.type === "web_search").length,
    },
  };
}

/**
 * Sorts a failed call by the tools' own wording. Neither tool documents its
 * messages, so these are the phrasings seen from Claude Code 2.1 and Codex
 * 0.160 ("Not logged in · Please run /login", "401 Unauthorized", "You've hit
 * your usage limit"). Anything else keeps the tool's message for the detail.
 */
export function classifyCliFailure(message: string, status: number | null): CliFailure {
  if (
    status === 401 ||
    /not logged in|\/login|(?:log|sign) ?in again|authentication_failed|unauthori[sz]ed/i.test(
      message,
    )
  ) {
    return { kind: "sign_in", message };
  }
  if (
    status === 429 ||
    /usage limit|hit your limit|limit reached|rate.?limit|too many requests/i.test(message)
  ) {
    return { kind: "plan_limit", message };
  }
  if (status !== null) return { kind: "refused", status, message };
  return { kind: "failed", message };
}

interface Exit {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the program could not be started at all. */
  startError: string | null;
}

/** Stops the tool and everything it started. */
function stopTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    // Killing the pid alone would leave the native tool running when it was
    // started through its npm launcher's JS runtime.
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    }).on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** Runs one process to its end or its deadline. Exported for the timeout test. */
export function runProcess(
  launch: Launch,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number },
): Promise<Exit> {
  return new Promise((resolve) => {
    const exit: Exit = { stdout: "", stderr: "", timedOut: false, startError: null };
    const child = spawn(launch.file, [...launch.prefix, ...args], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      // Its own process group off Windows, so stopTree reaches its children.
      detached: process.platform !== "win32",
    });
    const timer = setTimeout(() => {
      exit.timedOut = true;
      stopTree(child);
    }, options.timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      resolve(exit);
    };
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      exit.stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      exit.stderr += chunk;
    });
    child.on("error", (error) => {
      exit.startError = error.message;
      finish();
    });
    child.on("close", finish);
    // A tool that exits before reading its input closes the pipe under the write.
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.stdin);
  });
}

function lastLines(text: string): string {
  return text.trim().split(/\r?\n/).slice(-5).join("\n");
}

/**
 * One call through the provider's command. Never throws for a failed call.
 * `launch` is injected by the tests, which start a stand-in tool.
 */
export async function callCli(call: CliCall, launch?: Launch): Promise<CliOutcome> {
  const { provider, command } = call.target;
  const lookup: LaunchLookup = launch ? { found: true, launch } : lookupLaunch(command);
  if (!lookup.found) {
    return {
      ok: false,
      failure: { kind: "sign_in", message: launchProblem(provider, command, lookup) },
    };
  }

  const dir = mkdtempSync(join(tmpdir(), "overheard-cli-"));
  try {
    const files: CallFiles = { instructions: join(dir, "instructions.md"), schema: null };
    writeFileSync(files.instructions, call.system);
    if (call.jsonSchema && provider === "openai") {
      files.schema = join(dir, "schema.json");
      writeFileSync(files.schema, JSON.stringify(call.jsonSchema.schema));
    }
    const args = provider === "anthropic" ? claudeArgs(call, files) : codexArgs(call, files);
    const started = Date.now();
    const exit = await runProcess(lookup.launch, args, {
      cwd: dir,
      env: cliEnv(call),
      stdin: call.user,
      timeoutMs: call.timeoutMs,
    });

    if (exit.startError !== null) {
      return {
        ok: false,
        failure: {
          kind: "sign_in",
          message: `${PROVIDER_CLI[provider].command} could not be started: ${exit.startError}`,
        },
      };
    }
    if (exit.timedOut) {
      return {
        ok: false,
        failure: {
          kind: "timeout",
          message: `stopped after ${Date.now() - started}ms of a ${call.timeoutMs}ms budget`,
        },
      };
    }
    const reading = provider === "anthropic" ? readClaude(exit.stdout) : readCodex(exit.stdout);
    if (reading.ok) return reading;
    const message =
      reading.message.trim() || lastLines(exit.stderr) || "the command printed nothing";
    return { ok: false, failure: classifyCliFailure(message, reading.status) };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A stopped process can hold the folder on Windows for a moment. The
      // system's temporary folder is cleaned on its own schedule.
    }
  }
}
