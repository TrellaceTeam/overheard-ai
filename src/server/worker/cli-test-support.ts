/**
 * A stand-in for `claude` or `codex` in tests: a script the platform can start
 * as a command, so subscription mode runs end to end with no real tool. On
 * Windows it sits behind the kind of .cmd launcher npm writes, which
 * cli-command.ts reads. Elsewhere it is an executable script.
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Prints what a signed-out Claude Code prints, and fails. Its "Not logged in"
 * also reads as signed out to the status commands.
 */
export const SIGNED_OUT_TOOL = `process.stdout.write(JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" }) + "\\n");
process.exit(1);`;

/**
 * Answers both tools' status commands signed in, the way Claude Code 2.1.285
 * and Codex 0.163.0 do, and fails anything else. Claude Code's status names
 * the account, here a fictional one.
 */
export const SIGNED_IN_TOOL = `const args = process.argv.slice(2).join(" ");
if (args === "auth status") { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "someone@example.invalid" }) + "\\n"); process.exit(0); }
if (args === "login status") { process.stderr.write("Logged in using ChatGPT\\n"); process.exit(0); }
process.exit(1);`;

/** The full path of a new stand-in command that runs `source`. */
export function standInCommand(source: string = SIGNED_OUT_TOOL): string {
  const dir = mkdtempSync(join(tmpdir(), "overheard-stand-in-"));
  writeFileSync(join(dir, "tool.cjs"), source);
  if (process.platform === "win32") {
    const launcher = join(dir, "tool.cmd");
    writeFileSync(launcher, '@"%~dp0\\tool.cjs" %*\r\n');
    return launcher;
  }
  const command = join(dir, "tool");
  writeFileSync(command, `#!/usr/bin/env node\n${source}\n`);
  chmodSync(command, 0o755);
  return command;
}
