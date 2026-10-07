/**
 * Where a provider key comes from, and what the screens may learn about it:
 * whether there is one.
 *
 * Keys are read from the environment at call time, never at module scope, and
 * never written to the database, so a copy of the SQLite file holds no key.
 * Each read first brings the key variables in line with .env (env-file.ts),
 * so a key added while the app runs is used without a restart.
 * Only resolveProviderKey and providerKeyValues return key values, for the
 * adapters and the error scrubber. Nothing here logs or renders one.
 * keyStatus() is all the Settings and Start screens see.
 *
 * A provider in subscription mode needs no key: its variable names the
 * command line tool it is asked through, and that tool signs in with the
 * user's plan. The mode applies only while the provider has no key and the
 * command is installed, so .env.example can name both commands for everyone.
 * Precedence is the mock seam, then a key, then subscription mode.
 */
import type { Provider } from "../db/types";
import { isCliProvider, PROVIDER_CLI, type CliProvider } from "@/lib/provider-keys";
import { cliProblem, lookupLaunch } from "./cli-command";
import { refreshEnvKeys } from "./env-file";
import { mockProvidersEnabled } from "./mock-provider";

// The env var names per provider, in the order they are tried. GEMINI_API_KEY
// is an accepted alias for GOOGLE_API_KEY because Google's own quickstarts use
// it. The map lives in lib/provider-keys so the screens that name a variable
// and this reader agree.
export { PROVIDER_KEY_ENV } from "@/lib/provider-keys";
import { PROVIDER_KEY_ENV } from "@/lib/provider-keys";

/** The three providers with a native adapter. Order is display order. */
export const PROVIDERS: readonly Provider[] = ["openai", "anthropic", "google"];

/**
 * A placeholder handed to the mock provider so the call path is identical with
 * and without keys. It is not a secret and never leaves the process: the mock
 * adapter short-circuits before any request is built.
 */
export const MOCK_KEY = "mock-mode-no-key-required";

/**
 * The same kind of placeholder for a provider in subscription mode. callProvider
 * hands the call to the provider's command before any request is built, and
 * the command signs in on its own.
 */
export const CLI_KEY = "subscription-mode-no-key-required";

/** A provider in subscription mode and the command it is asked through. */
export interface CliTarget {
  provider: CliProvider;
  /** A command name found on PATH, or a path to the program. */
  command: string;
}

/**
 * The command a provider is asked through, or null when it is asked through
 * its API: it has a key, its variable is empty, or the command is not
 * installed. Read at call time, like a key, so a line added to .env or a tool
 * installed later applies without a restart. A command that is found but
 * cannot be started still counts, so the key panel can say why.
 */
export function providerCli(provider: string): CliTarget | null {
  if (!isCliProvider(provider)) return null;
  refreshEnvKeys();
  const command = process.env[PROVIDER_CLI[provider].env]?.trim();
  if (!command || envKey(provider) !== null) return null;
  const lookup = lookupLaunch(command);
  return lookup.found || lookup.reason === "unstartable" ? { provider, command } : null;
}

/** Whether calls to this provider cost the install nothing: the offline seam, or a plan. */
export function billsNothing(provider: string): boolean {
  return mockProvidersEnabled() || providerCli(provider) !== null;
}

/**
 * Accepts only printable ASCII without spaces (0x21-0x7E).
 *
 * A key pasted from a web page or a PDF can carry a non-breaking space, a
 * zero-width space or a stray control character. Node's fetch refuses the
 * header, its TypeError quotes the value in full, and that error is retryable,
 * so it would reach run_tasks.error, stdout and the dashboard's failure strip.
 * A value that fails this check counts as no key, and the message that says so
 * never repeats it.
 */
function isHeaderSafe(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

/** What is in the environment for one provider, before it is judged. */
function envKey(provider: Provider): string | null {
  refreshEnvKeys();
  for (const name of PROVIDER_KEY_ENV[provider]) {
    const value = process.env[name];
    if (value?.trim()) return value.trim();
  }
  return null;
}

/** Said when a key is present but cannot be sent. Never quotes the value. */
export const UNUSABLE_KEY_MESSAGE =
  "That key contains a character that is not valid in an HTTP header. Retype it rather than pasting it.";

/** The key for one provider, or null when there is none this process can send. */
export function resolveProviderKey(provider: Provider): string | null {
  if (mockProvidersEnabled()) return MOCK_KEY;
  if (providerCli(provider)) return CLI_KEY;
  const value = envKey(provider);
  if (value === null) return null;
  return isHeaderSafe(value) ? value : null;
}

/**
 * Every key value in the environment, for scrubError to replace literally.
 * Its shape patterns need eight key characters right after a known prefix,
 * which a key with an invisible character near its start does not have. Read
 * at call time, like every other read of a key.
 */
export function providerKeyValues(): string[] {
  refreshEnvKeys();
  const values = new Set<string>();
  for (const names of Object.values(PROVIDER_KEY_ENV)) {
    for (const name of names) {
      const raw = process.env[name];
      if (!raw) continue;
      // Short values are left alone: replacing a two-character string would
      // shred an unrelated message and cannot be protecting a real key.
      if (raw.length >= MIN_SCRUBBABLE_KEY) values.add(raw);
      const trimmed = raw.trim();
      if (trimmed.length >= MIN_SCRUBBABLE_KEY) values.add(trimmed);
    }
  }
  return [...values];
}

/** Below this length a value is not a provider key and is not worth masking. */
const MIN_SCRUBBABLE_KEY = 8;

/**
 * Providers the process can call right now. Under the mock seam that is all
 * three. Whether a key exists is keyStatus()'s question.
 */
export function configuredProviders(): Provider[] {
  return PROVIDERS.filter((provider) => resolveProviderKey(provider) !== null);
}

/** At least one key is required before a run can be created. */
export function hasAnyProviderKey(): boolean {
  return configuredProviders().length > 0;
}

export interface ProviderKeyStatus {
  provider: Provider;
  /** Whether this process can call the provider. Never the key, never a length. */
  configured: boolean;
  /**
   * Why it can. "env" is a usable key in the environment, "mock" is the
   * offline seam answering whether or not a key exists, "cli" is subscription
   * mode, "none" is none of them. Without it, `configured` would read as "key
   * found" under the mock seam on a machine with no keys.
   */
  source: "env" | "mock" | "cli" | "none";
  /**
   * A fixed sentence when a key is present but unusable, or when a
   * subscription-mode command cannot be started or will not answer cleanly.
   * Never a key value.
   */
  problem: string | null;
}

/**
 * What the interface is allowed to show. Booleans and fixed sentences only, so a
 * screenshot of the Settings page can be pasted into a bug report without
 * redacting anything.
 */
export function keyStatus(): ProviderKeyStatus[] {
  const mocked = mockProvidersEnabled();
  return PROVIDERS.map((provider) => {
    const value = envKey(provider);
    const usable = value !== null && isHeaderSafe(value);
    const problem = value !== null && !usable ? UNUSABLE_KEY_MESSAGE : null;
    if (mocked) return { provider, configured: true, source: "mock" as const, problem };
    const cli = providerCli(provider);
    if (cli) {
      return {
        provider,
        configured: true,
        source: "cli" as const,
        problem: cliProblem(cli.provider, cli.command),
      };
    }
    return {
      provider,
      configured: usable,
      source: usable ? ("env" as const) : ("none" as const),
      problem,
    };
  });
}
