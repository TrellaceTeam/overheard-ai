/**
 * What each operating system's Overheard AI icon holds. Pure, so the quoting
 * can be tested. scripts/shortcut.ts writes them.
 *
 * Every icon runs one command from the app's folder, and server/index.mjs
 * decides what a click means: open the browser when the app is running, start
 * it when it is not. So no icon holds any logic of its own.
 */
import { posix, win32 } from "node:path";

/** What every icon runs, from the app's folder. */
export const ENTRY_ARGS = ["--env-file-if-exists=.env", "server/index.mjs", "--open"] as const;

export const APP_NAME = "Overheard AI";

export interface Launch {
  /** Absolute path to the Node that ran `npm run shortcut`. */
  node: string;
  /** The app's folder. */
  root: string;
  /** The PATH of the terminal that ran `npm run shortcut`. */
  path: string;
}

export interface WindowsShortcut {
  target: string;
  args: string;
  workingDirectory: string;
  icon: string;
}

/**
 * A shortcut that starts Node through `conhost.exe --headless`: a console with
 * no window, so nothing flashes, and a console program the app starts opens no
 * window either. Windows paths cannot contain a double quote, so quoting the
 * Node path is enough.
 */
export function windowsShortcut(launch: Launch, systemRoot: string): WindowsShortcut {
  return {
    target: win32.join(systemRoot, "System32", "conhost.exe"),
    args: ["--headless", `"${launch.node}"`, ...ENTRY_ARGS].join(" "),
    workingDirectory: launch.root,
    icon: win32.join(launch.root, "scripts", "icon", "overheard-ai.ico"),
  };
}

/** A word for sh. Inside single quotes only a single quote ends the word. */
function shellWord(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * The shell line the Mac app runs. An app opened from Finder gets a bare PATH,
 * so the terminal's PATH is put back, which keeps node and any command line
 * tool the app starts findable. If the saved Node has moved, the one on that PATH is used. The
 * last command alone runs in the background with every stream redirected,
 * which is what lets `do shell script` return at once.
 */
export function macCommand(launch: Launch): string {
  return [
    `cd ${shellWord(launch.root)} || exit 1`,
    `export PATH=${shellWord(launch.path)}`,
    `node=${shellWord(launch.node)}`,
    `[ -x "$node" ] || node=node`,
    `nohup "$node" ${ENTRY_ARGS.join(" ")} </dev/null >/dev/null 2>&1 &`,
  ].join("; ");
}

/** The AppleScript osacompile turns into the Mac app. */
export function macAppleScript(launch: Launch): string {
  const command = macCommand(launch).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `do shell script "${command}"`;
}

/**
 * An argument in a desktop entry's Exec key: double-quoted, with the four
 * characters the Desktop Entry spec reserves inside quotes escaped.
 */
function execArgument(text: string): string {
  return `"${text.replace(/["`$\\]/g, "\\$&")}"`;
}

/** A string value in a desktop entry, where a backslash is itself escaped. */
function desktopString(text: string): string {
  return text.replaceAll("\\", "\\\\");
}

/** The Linux desktop entry. `%` starts a field code in Exec, so it is doubled. */
export function linuxDesktopEntry(launch: Launch): string {
  const exec = [
    "env",
    execArgument(`PATH=${launch.path}`),
    execArgument(launch.node),
    ...ENTRY_ARGS,
  ]
    .join(" ")
    .replaceAll("%", "%%");
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${APP_NAME}`,
    "Comment=See what AI assistants say about your brand",
    `Exec=${desktopString(exec)}`,
    `Path=${desktopString(launch.root)}`,
    `Icon=${desktopString(posix.join(launch.root, "scripts", "icon", "overheard-ai.png"))}`,
    "Terminal=false",
    "Categories=Office;",
    "",
  ].join("\n");
}
