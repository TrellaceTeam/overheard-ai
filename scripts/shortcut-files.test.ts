import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { linuxDesktopEntry, macAppleScript, macCommand, windowsShortcut } from "./shortcut-files";

describe("windowsShortcut", () => {
  it("starts Node through a console with no window, from the app's folder", () => {
    const shortcut = windowsShortcut(
      { node: "C:\\Program Files\\nodejs\\node.exe", root: "D:\\Apps\\Overheard AI", path: "" },
      "C:\\Windows",
    );
    expect(shortcut).toEqual({
      target: "C:\\Windows\\System32\\conhost.exe",
      args: '--headless "C:\\Program Files\\nodejs\\node.exe" --env-file-if-exists=.env server/index.mjs --open',
      workingDirectory: "D:\\Apps\\Overheard AI",
      icon: "D:\\Apps\\Overheard AI\\scripts\\icon\\overheard-ai.ico",
    });
  });

  it.runIf(process.platform === "win32")(
    "really runs Node with .env and the entry's arguments, in the app's folder, and keeps it running",
    async () => {
      // The stand-in writes its record after a pause, so the record proves Node
      // outlived the moment conhost returned, which some Windows builds do at once.
      const root = stagedApp("Overheard AI", 1500);
      const shortcut = windowsShortcut(
        { node: process.execPath, root, path: "" },
        process.env["SystemRoot"] ?? "C:\\Windows",
      );
      const result = spawnSync(shortcut.target, [shortcut.args], {
        cwd: shortcut.workingDirectory,
        windowsVerbatimArguments: true,
        timeout: 20_000,
      });
      expect(result.status).toBe(0);
      const ran = await waitForFile(join(root, "ran.json"));
      expect(JSON.parse(ran)).toEqual({ args: ["--open"], fromEnvFile: "yes" });
    },
    30_000,
  );
});

describe("macCommand", () => {
  const launch = {
    node: "/Users/sam/.nvm/versions/node/v24.1.0/bin/node",
    root: `/Users/sam/Sam's "apps"/overheard ai`,
    path: "/Users/sam/.local/bin:/opt/homebrew/bin:/usr/bin:/bin",
  };

  it("puts the terminal's PATH back and starts the entry in the background", () => {
    expect(macCommand(launch)).toBe(
      `cd '/Users/sam/Sam'\\''s "apps"/overheard ai' || exit 1; ` +
        `export PATH='/Users/sam/.local/bin:/opt/homebrew/bin:/usr/bin:/bin'; ` +
        `node='/Users/sam/.nvm/versions/node/v24.1.0/bin/node'; ` +
        `[ -x "$node" ] || node=node; ` +
        `nohup "$node" --env-file-if-exists=.env server/index.mjs --open </dev/null >/dev/null 2>&1 &`,
    );
  });

  it("escapes the line for AppleScript", () => {
    expect(macAppleScript(launch)).toBe(
      `do shell script "cd '/Users/sam/Sam'\\\\''s \\"apps\\"/overheard ai' || exit 1; ` +
        `export PATH='/Users/sam/.local/bin:/opt/homebrew/bin:/usr/bin:/bin'; ` +
        `node='/Users/sam/.nvm/versions/node/v24.1.0/bin/node'; ` +
        `[ -x \\"$node\\" ] || node=node; ` +
        `nohup \\"$node\\" --env-file-if-exists=.env server/index.mjs --open </dev/null >/dev/null 2>&1 &"`,
    );
  });

  it.runIf(process.platform !== "win32")(
    "really runs Node with .env from a folder whose name needs quoting, and returns at once",
    async () => {
      const root = stagedApp(`Sam's "apps" $HOME`);
      const result = spawnSync(
        "/bin/sh",
        ["-c", macCommand({ node: process.execPath, root, path: process.env["PATH"] ?? "" })],
        { timeout: 5_000 },
      );
      expect(result.status).toBe(0);
      const ran = await waitForFile(join(root, "ran.json"));
      expect(JSON.parse(ran)).toEqual({ args: ["--open"], fromEnvFile: "yes" });
    },
    30_000,
  );
});

describe("linuxDesktopEntry", () => {
  it("quotes the command the way the Desktop Entry spec asks", () => {
    const entry = linuxDesktopEntry({
      node: "/home/sam/.nvm/versions/node/v24.1.0/bin/node",
      root: "/home/sam/my apps/overheard-ai",
      path: "/home/sam/bin:/usr/bin:$EXTRA:100%",
    });
    expect(entry).toBe(
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Overheard AI",
        "Comment=See what AI assistants say about your brand",
        'Exec=env "PATH=/home/sam/bin:/usr/bin:\\\\$EXTRA:100%%" "/home/sam/.nvm/versions/node/v24.1.0/bin/node" --env-file-if-exists=.env server/index.mjs --open',
        "Path=/home/sam/my apps/overheard-ai",
        "Icon=/home/sam/my apps/overheard-ai/scripts/icon/overheard-ai.png",
        "Terminal=false",
        "Categories=Office;",
        "",
      ].join("\n"),
    );
  });
});

/**
 * A folder shaped like the app, whose server/index.mjs only records how it was
 * started: its arguments, and a value it can only have read from .env. It
 * writes the record after `delayMs`.
 */
function stagedApp(name = "Overheard AI", delayMs = 0): string {
  const root = join(mkdtempSync(join(tmpdir(), "overheard-shortcut-")), name);
  mkdirSync(join(root, "server"), { recursive: true });
  writeFileSync(join(root, ".env"), "SHORTCUT_TEST=yes\n");
  writeFileSync(
    join(root, "server", "index.mjs"),
    `import { writeFileSync } from "node:fs";
const record = { args: process.argv.slice(2), fromEnvFile: process.env.SHORTCUT_TEST };
setTimeout(() => writeFileSync("ran.json", JSON.stringify(record)), ${delayMs});
`,
  );
  return root;
}

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`${path} never appeared`);
}
