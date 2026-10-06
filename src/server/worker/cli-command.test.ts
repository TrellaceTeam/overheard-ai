import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliProblem, findCommand, lookupLaunch, readCmdLauncher } from "./cli-command";

/** A folder holding one startable command, the way this platform starts one. */
function folderWithCommand(name: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "overheard-path-"));
  const windows = process.platform === "win32";
  const file = join(dir, windows ? `${name}.exe` : name);
  writeFileSync(file, windows ? "" : "#!/bin/sh\necho hi\n");
  if (!windows) chmodSync(file, 0o755);
  return { dir, file };
}

describe("findCommand", () => {
  it("finds a command in a PATH folder, as a terminal would", () => {
    const { dir, file } = folderWithCommand("assistant-cli");
    const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    expect(findCommand("assistant-cli", env)).toBe(file);
  });

  it("takes a path as given", () => {
    const { file } = folderWithCommand("assistant-cli");
    expect(findCommand(file, {})).toBe(file);
  });

  it("is null for a command that is nowhere on PATH", () => {
    const { dir } = folderWithCommand("assistant-cli");
    expect(findCommand("another-cli", { PATH: dir })).toBeNull();
  });
});

describe("readCmdLauncher", () => {
  // The launcher npm writes for a package whose bin is a script.
  const NPM_SCRIPT_LAUNCHER = [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@example\\assistant-cli\\bin\\cli.js" %*',
  ].join("\r\n");

  it("runs a script launcher's script under the given JS runtime", () => {
    expect(
      readCmdLauncher(
        "C:\\Users\\a\\npm\\assistant.cmd",
        NPM_SCRIPT_LAUNCHER,
        "C:\\node\\node.exe",
      ),
    ).toEqual({
      file: "C:\\node\\node.exe",
      prefix: ["C:\\Users\\a\\npm\\node_modules\\@example\\assistant-cli\\bin\\cli.js"],
    });
  });

  it("starts a native program's launcher target directly", () => {
    const launcher = '@"%~dp0\\node_modules\\@example\\assistant-cli\\bin\\assistant.exe"   %*\r\n';
    expect(readCmdLauncher("C:\\npm\\assistant.cmd", launcher)).toEqual({
      file: "C:\\npm\\node_modules\\@example\\assistant-cli\\bin\\assistant.exe",
      prefix: [],
    });
  });

  it("refuses any other batch file", () => {
    expect(readCmdLauncher("C:\\tools\\assistant.bat", "@echo off\r\ncall other.bat %*\r\n")).toBe(
      null,
    );
  });
});

describe("lookupLaunch", () => {
  it("starts a native program with no arguments of its own", () => {
    const { dir, file } = folderWithCommand("assistant-cli");
    expect(lookupLaunch("assistant-cli", { PATH: dir, PATHEXT: ".EXE" })).toEqual({
      found: true,
      launch: { file, prefix: [] },
    });
  });

  it("says not found for a missing command", () => {
    expect(lookupLaunch("assistant-cli", { PATH: "" })).toEqual({
      found: false,
      reason: "not_found",
    });
  });
});

describe("cliProblem", () => {
  it("names the tool to install and the variable to set when the command is missing", () => {
    expect(cliProblem("openai", "codex", { PATH: "" })).toBe(
      'Overheard AI cannot find "codex". Install Codex and sign in to it, or set OVERHEARD_OPENAI_CLI to the command\'s full path.',
    );
  });

  it("warns that Codex sends the user's own instructions file with every question", () => {
    const { dir } = folderWithCommand("codex");
    const home = mkdtempSync(join(tmpdir(), "overheard-codex-home-"));
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "AGENTS.md"), "Always answer in French.");
    const env = { PATH: dir, PATHEXT: ".EXE", CODEX_HOME: home };
    expect(cliProblem("openai", "codex", env)).toBe(
      `Codex adds your own instructions file, ${join(home, "AGENTS.md")}, to every question, so the answers follow it. Empty it or move it aside while Overheard AI measures.`,
    );
    writeFileSync(join(home, "AGENTS.md"), "  \n");
    expect(cliProblem("openai", "codex", env)).toBeNull();
  });
});
