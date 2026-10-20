/**
 * Where a subscription-mode command line tool lives, how to start it without a
 * shell, and what stops it from being ready.
 *
 * A command is found the way a terminal finds it: a path as given, otherwise
 * each PATH directory in order, and on Windows each PATHEXT extension a
 * process can start. A shell is never involved, so no argument is ever
 * re-parsed. That matters on Windows, where a .cmd file only runs under
 * cmd.exe, and cmd.exe's quoting cannot carry a JSON schema safely. The .cmd
 * launchers npm, pnpm and Yarn write are read instead for the program they
 * start, and that program is started directly.
 */
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve, win32 } from "node:path";
import { PROVIDER_CLI, type CliProvider } from "@/lib/provider-keys";

/** A program and the arguments that go before the call's own. */
export interface Launch {
  file: string;
  /** The script, when `file` is a JS runtime. Empty for a native program. */
  prefix: string[];
}

export type LaunchLookup =
  | { found: true; launch: Launch }
  | { found: false; reason: "not_found" }
  | { found: false; reason: "unstartable"; path: string };

type Env = Partial<Record<string, string | undefined>>;

const WINDOWS_STARTABLE = [".exe", ".com", ".cmd", ".bat"];

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return isFile(path);
  } catch {
    return false;
  }
}

function withExtensions(base: string, env: Env): string[] {
  const lower = base.toLowerCase();
  if (WINDOWS_STARTABLE.some((ext) => lower.endsWith(ext))) return [base];
  return (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => WINDOWS_STARTABLE.includes(ext))
    .map((ext) => base + ext);
}

/** The file a command names, or null when nothing startable answers to it. */
export function findCommand(
  command: string,
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const windows = platform === "win32";
  const bases =
    /[\\/]/.test(command) || isAbsolute(command)
      ? [resolve(command)]
      : // Windows spells the variable Path. process.env reads it either way,
        // a copied object does not.
        (env["PATH"] ?? env["Path"] ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => join(dir, command));
  for (const base of bases) {
    for (const candidate of windows ? withExtensions(base, env) : [base]) {
      if (windows ? isFile(candidate) : isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The program a package manager's .cmd launcher starts. The launchers end by
 * running a quoted path under their own folder (`%dp0%` or `%~dp0`) with the
 * caller's arguments (`%*`). A script runs under `runtime`, a native program
 * as it is. Null for any other batch file.
 */
export function readCmdLauncher(
  cmdPath: string,
  text: string,
  runtime: string = process.execPath,
): Launch | null {
  const targets = [...text.matchAll(/"%~?dp0%?\\?([^"%]+)"\s+%\*/gi)];
  const relative = targets.at(-1)?.[1];
  if (!relative) return null;
  const target = win32.join(win32.dirname(cmdPath), relative);
  if (/\.exe$/i.test(target)) return { file: target, prefix: [] };
  if (/\.[cm]?js$/i.test(target)) return { file: runtime, prefix: [target] };
  return null;
}

/** How to start a command, or why it cannot be. */
export function lookupLaunch(
  command: string,
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): LaunchLookup {
  const path = findCommand(command, env, platform);
  if (path === null) return { found: false, reason: "not_found" };
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(path)) {
    return { found: true, launch: { file: path, prefix: [] } };
  }
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // Unreadable reads as a batch file this module cannot start.
  }
  const launch = readCmdLauncher(path, text);
  return launch ? { found: true, launch } : { found: false, reason: "unstartable", path };
}

/** The sentence a screen shows when a command cannot be started. */
export function launchProblem(
  provider: CliProvider,
  command: string,
  lookup: Exclude<LaunchLookup, { found: true }>,
): string {
  const cli = PROVIDER_CLI[provider];
  return lookup.reason === "not_found"
    ? `Overheard AI cannot find "${command}". Install ${cli.tool} and sign in to it, or set ${cli.env} to the command's full path.`
    : `${lookup.path} is a batch file Overheard AI cannot start directly. Set ${cli.env} to the program it runs, a .exe or .js file.`;
}

/**
 * Codex sends the user's own instructions file with every request, whatever
 * the request asks, and has no setting that leaves it out. Codex reads the
 * first non-empty one of these two.
 */
function codexInstructionsFile(env: Env): string | null {
  const home = env["CODEX_HOME"]?.trim() || join(homedir(), ".codex");
  for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
    const path = join(home, name);
    try {
      if (readFileSync(path, "utf8").trim() !== "") return path;
    } catch {
      // Absent, which is the normal case.
    }
  }
  return null;
}

/**
 * What stops a configured command from giving clean answers, as one sentence,
 * or null. A file stat or two, cheap enough for every read of the key panel.
 * Whether the tool is signed in is the setup check's question, because only a
 * call can answer it.
 */
export function cliProblem(
  provider: CliProvider,
  command: string,
  env: Env = process.env,
): string | null {
  const lookup = lookupLaunch(command, env);
  if (!lookup.found) return launchProblem(provider, command, lookup);
  if (provider === "openai") {
    const file = codexInstructionsFile(env);
    if (file) {
      return `Codex adds your own instructions file, ${file}, to every question, so the answers follow it. Empty it or move it aside while Overheard AI measures.`;
    }
  }
  return null;
}
