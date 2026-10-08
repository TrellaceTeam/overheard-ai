/**
 * `npm run shortcut`: adds an Overheard AI icon where this computer keeps its
 * apps, then opens the app the way the icon does.
 *
 * - Windows: a shortcut in the Start menu and on the desktop.
 * - macOS: an app in ~/Applications, so Spotlight, Launchpad and the Dock find
 *   it. osacompile builds it, because it ships with every Mac and signs what it
 *   builds.
 * - Linux: a desktop entry in ~/.local/share/applications.
 *
 * Running it again rewrites the icons with the current paths, which is the fix
 * when the folder moves or Node is reinstalled. scripts/shortcut-files.ts says
 * what each icon holds and why.
 */
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_NAME,
  ENTRY_ARGS,
  type Launch,
  linuxDesktopEntry,
  macAppleScript,
  windowsShortcut,
} from "./shortcut-files";

const launch: Launch = {
  node: process.execPath,
  root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  path: process.env["PATH"] ?? "",
};

const places =
  process.platform === "win32"
    ? addWindowsShortcuts()
    : process.platform === "darwin"
      ? addMacApp()
      : addLinuxEntry();

console.log(`Added ${APP_NAME} to:`);
for (const place of places) console.log(`  ${place}`);

// The same command the icon runs, detached so it outlives this terminal.
spawn(launch.node, [...ENTRY_ARGS], {
  cwd: launch.root,
  detached: true,
  stdio: "ignore",
  windowsHide: true,
}).unref();
console.log(`Opening ${APP_NAME} in your browser. From now on, open it from its icon.`);

/**
 * PowerShell writes the .lnk files, because Node cannot. The values travel as
 * environment variables, so no path is ever quoted into the script.
 */
function addWindowsShortcuts(): string[] {
  const shortcut = windowsShortcut(launch, process.env["SystemRoot"] ?? "C:\\Windows");
  const script = `
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
  $link = $shell.CreateShortcut((Join-Path $folder '${APP_NAME}.lnk'))
  $link.TargetPath = $env:OVERHEARD_LINK_TARGET
  $link.Arguments = $env:OVERHEARD_LINK_ARGS
  $link.WorkingDirectory = $env:OVERHEARD_LINK_DIR
  $link.IconLocation = $env:OVERHEARD_LINK_ICON
  $link.Description = 'Open ${APP_NAME}'
  $link.WindowStyle = 7
  $link.Save()
  $link.FullName
}`;
  const output = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        OVERHEARD_LINK_TARGET: shortcut.target,
        OVERHEARD_LINK_ARGS: shortcut.args,
        OVERHEARD_LINK_DIR: shortcut.workingDirectory,
        OVERHEARD_LINK_ICON: shortcut.icon,
      },
    },
  );
  return output.split(/\r?\n/).filter((line) => line.trim() !== "");
}

function addMacApp(): string[] {
  const folder = join(homedir(), "Applications");
  const app = join(folder, `${APP_NAME}.app`);
  const resources = join(app, "Contents", "Resources");
  mkdirSync(folder, { recursive: true });
  rmSync(app, { recursive: true, force: true });
  execFileSync("osacompile", ["-o", app, "-e", macAppleScript(launch)]);

  copyFileSync(
    join(launch.root, "scripts", "icon", "overheard-ai.icns"),
    join(resources, "applet.icns"),
  );
  // An asset catalog's icon wins over applet.icns, so drop it where there is one.
  if (existsSync(join(resources, "Assets.car"))) {
    rmSync(join(resources, "Assets.car"));
    tryRun("plutil", ["-remove", "CFBundleIconName", join(app, "Contents", "Info.plist")]);
  }
  // The new icon breaks the signature osacompile made, so sign it again the
  // same way, ad hoc.
  tryRun("codesign", ["--force", "--sign", "-", app]);
  return [app];
}

function addLinuxEntry(): string[] {
  const data = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share");
  const folder = join(data, "applications");
  const file = join(folder, "overheard-ai.desktop");
  mkdirSync(folder, { recursive: true });
  writeFileSync(file, linuxDesktopEntry(launch));
  return [file];
}

function tryRun(command: string, args: string[]): void {
  try {
    execFileSync(command, args, { stdio: "ignore" });
  } catch {
    // Cosmetic: the app runs either way.
  }
}
