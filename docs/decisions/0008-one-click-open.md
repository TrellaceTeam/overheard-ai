# ADR 0008: One click opens the app, and starts it first when it is not running

Status: proposed 2026-10-07.

## Decision

`npm run shortcut` adds an Overheard AI icon where the operating system keeps its apps: the
Start menu and the desktop on Windows, `~/Applications` on a Mac, `~/.local/share/applications`
on Linux. Then it opens the app the way the icon does. Running it again rewrites the icons
with the current paths.

Every icon runs one command in the app's folder:
`node --env-file-if-exists=.env server/index.mjs --open`. The production entry decides what a
click means, so no icon holds logic of its own:

- If Overheard AI already holds the port, it opens the browser and leaves.
- If another program holds it, it opens a page that says so and how to change `PORT`.
- Otherwise it opens the browser at once onto a page that waits, rebuilds first when the code
  is newer than the last build, then loads the app. Started from an icon there is no console,
  so its output goes to `data/overheard.log`, and a start that fails shows the reason in that
  same tab.

The entry takes the port before it imports the built app. Importing boots it, and boot
recovery returns every in-flight task to the queue, which is right only when no other process
is asking them. So the port is the lock: a second copy on the same port leaves before it opens
the database. `vite dev` sets `strictPort` for the same reason, instead of moving to the next
free port next to an Overheard AI the icon started. Every response carries `x-overheard-ai`,
so a second start can tell Overheard AI from another program on the port.

The menu's Quit stops the process, because an Overheard AI started from an icon has no
console to press Ctrl-C in. Closing the browser tab does not stop it.

Account settings has one switch, "Rebuild after the code changes", stored as
`app_state.rebuild_on_open` and on by default. The entry reads it straight from the database
before boot, because the app that would normally read it is the build in question. A missing
build is always built. A rebuild runs only on code already on disk, such as after a `git
pull`, and never downloads anything.

### Per system

- **Windows.** A shortcut to `conhost.exe --headless`, which gives Node a console with no
  window. A shortcut straight to `node.exe` opens a console window. A `.vbs` launcher hides it,
  but Microsoft is removing VBScript from Windows. PowerShell writes the `.lnk` files, and the
  paths reach it as environment variables, never quoted into its script.
- **macOS.** An app built by `osacompile`, which ships with every Mac, with the icon swapped in
  and signed again ad hoc. Spotlight, Launchpad and the Dock find it. An app opened from Finder
  gets a bare `PATH`, so the app restores the `PATH` of the terminal `npm run shortcut` ran in.
  Without it, `node` would not be found, nor any command line tool the app starts itself. The
  shell line backgrounds only its last command with every stream
  redirected, which is what lets `do shell script` return at once.
- **Linux.** A desktop entry, with the same `PATH`, quoted the way the Desktop Entry spec asks.

## Alternatives considered

- **A bookmark alone.** A browser cannot start a program. A bookmark works while the app runs,
  and the icon is the click that always works.
- **A custom `overheard://` link.** It needs a registry or plist entry, browsers ask permission
  on each use, and it would still need this same start command behind it.
- **An installable web app.** It gives an icon, but it cannot start the server.
- **A `.bat` or `.command` file.** It leaves a console window open, and closing that window
  stops the app.
- **Starting at sign-in, always on.** It would make schedules fire without a click, but it runs
  all the time and holds a port many developers use. It fits later as an opt-in.
- **An Electron or Tauri wrapper.** Over 100 MB per install, plus signing and notarisation.
- **Creating the icon in a `postinstall` hook.** npm runs it on every install, CI included, so
  a deleted icon would keep coming back, and `--ignore-scripts` skips it anyway.

## Consequences

- `conhost.exe --headless` is undocumented. Opened through the shell, as a double-click opens
  it, it runs Node with no window and keeps it running on Windows 10 22H2, Windows Server 2022
  and Windows Server 2025, which shares its build with Windows 11 24H2. Started from inside a
  console instead, conhost on build 26100 returns at once and runs nothing, so the shortcut has
  to be opened through the shell, and its test does that. The shortcut also asks Windows to
  start it minimised, in case a later release shows a window after all.
- The Mac app is untested on a physical Mac at the time of writing. CI builds it with
  `osacompile` and opens it with `open` on the macOS runner.
- A Mac app that starts in a folder macOS protects, such as Documents, may ask once for access.
- After the folder moves or Node is reinstalled, the icon points at the old path until
  `npm run shortcut` runs again. The Mac app falls back to the `node` on the saved `PATH`.
