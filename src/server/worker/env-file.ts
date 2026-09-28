/**
 * Provider keys re-read from the .env file while the app runs, so a key added
 * after start is picked up without a restart.
 *
 * Only the provider key variables are re-read. DATABASE_PATH, PORT and the mock
 * seam stay as they were at start: changing them under a running process would
 * move it to another database or port mid-run.
 *
 * A shell variable keeps winning. Whatever loaded .env at start (Vite, Bun,
 * Node's --env-file) left a shell value in place, so a key that differs from
 * the file at boot came from the shell, and a later edit to the file does not
 * override it either.
 *
 * Nothing is read until boot names the file. Tests do not boot the app through
 * src/server.ts, so a developer's real .env never reaches them.
 */
import { readFileSync, statSync } from "node:fs";
import { PROVIDER_KEY_ENV } from "@/lib/provider-keys";

interface EnvFileState {
  path: string;
  /** Key variables the shell set. The file never changes these. */
  pinned: ReadonlySet<string>;
  /** mtime and size at the last read, so an unchanged file is not re-parsed. */
  stamp: string | null;
}

// On globalThis, because a dev hot reload re-imports this module and must not
// forget which variables the shell set.
const STATE_KEY = Symbol.for("overheard.envFile");

type EnvFileGlobal = typeof globalThis & { [STATE_KEY]?: EnvFileState };

function keyVariables(): string[] {
  return Object.values(PROVIDER_KEY_ENV).flat();
}

/**
 * The KEY=VALUE lines of a .env file: comments, blank lines, an `export `
 * prefix, quoted values, and a ` #` comment after an unquoted value. That is
 * the part of dotenv syntax a key line uses.
 */
export function parseEnvFile(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1] as string;
    let value = (match[2] as string).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === "`") && value.indexOf(quote, 1) > 0) {
      value = value.slice(1, value.indexOf(quote, 1));
    } else {
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment);
      value = value.trim();
    }
    values.set(name, value);
  }
  return values;
}

function stampOf(path: string): string | null {
  try {
    const stats = statSync(path);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return null;
  }
}

function readValues(path: string): Map<string, string> {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return new Map();
  }
}

/**
 * Start re-reading provider keys from `path`. Called once, from boot. Later
 * calls keep the first file and the first view of which variables the shell
 * set.
 */
export function watchEnvFile(path: string): void {
  const holder = globalThis as EnvFileGlobal;
  if (holder[STATE_KEY]) return;
  const file = readValues(path);
  const pinned = new Set<string>();
  for (const name of keyVariables()) {
    const current = process.env[name]?.trim();
    if (current && current !== file.get(name)) pinned.add(name);
  }
  // No stamp yet, so the first lookup applies the file. Under `vite dev` the
  // app boots on the first request, and the file may have changed since the
  // process loaded it.
  holder[STATE_KEY] = { path, pinned, stamp: null };
}

/**
 * Bring the key variables in line with the file, if it changed since the last
 * read. Cheap enough for every key lookup: one stat when nothing changed.
 */
export function refreshEnvKeys(): void {
  const state = (globalThis as EnvFileGlobal)[STATE_KEY];
  if (!state) return;
  const stamp = stampOf(state.path);
  if (stamp === state.stamp) return;
  state.stamp = stamp;
  const values = stamp === null ? new Map<string, string>() : readValues(state.path);
  for (const name of keyVariables()) {
    if (state.pinned.has(name)) continue;
    const value = values.get(name);
    if (value) process.env[name] = value;
    else delete process.env[name];
  }
}

/** Stop re-reading. For tests. */
export function unwatchEnvFile(): void {
  delete (globalThis as EnvFileGlobal)[STATE_KEY];
}
