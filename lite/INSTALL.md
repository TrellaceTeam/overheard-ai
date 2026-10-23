# Install Overheard Lite

These steps are for the AI assistant a person asked to set up Overheard Lite. Most people who paste the link aren't technical. They copied one line from the README and expect you to do the rest. A person can follow these steps by hand too.

1. **Check where you're running.** Done when you know you're in Claude Code or Codex, with a terminal.
2. **Check the folder.** Done when the session works in an empty folder meant for Overheard.
3. **Get the kit.** Done when `.claude/skills/overheard/SKILL.md` and `.agents/skills/overheard/SKILL.md` are in the folder.
4. **Set it up.** Done when setup's last step is finished.

## 1. Check where you're running

Overheard Lite runs in Claude Code, which is the Code tab in the Claude app, and in Codex, which is in the ChatGPT app. It also runs in either one's terminal version. It needs a folder on the computer, so it doesn't run in a plain chat in claude.ai or ChatGPT.

When you're a chat without a terminal or a folder, tell the person that, and give them the steps to open the right place: in the Claude app, the **Code** tab, then choose a folder. In the ChatGPT app, **Codex**, then add a folder as a project. Give them the line they pasted, to paste again there, then stop.

## 2. Check the folder

The session's folder becomes the Overheard folder. It should be new and empty, with a plain name such as `Overheard`. Every helper that asks a question sees the folder's path, so a name that contains the brand can tilt answers.

When the folder holds other work, such as a code project, ask the person to make a new folder, open it in the app, and paste their line again there. Then stop.

## 3. Get the kit

Download the repository and copy its `lite/kit` folder's contents, hidden folders included, into this folder. When the person gave you a link to a branch, use that branch's name in place of `main`.

On a Mac or Linux:

```
curl -fsSL -o overheard.zip https://codeload.github.com/TrellaceTeam/overheard-ai/zip/refs/heads/main
unzip -q overheard.zip "overheard-ai-main/lite/kit/*"
cp -R overheard-ai-main/lite/kit/. .
rm -rf overheard.zip overheard-ai-main
```

On Windows, in PowerShell:

```
curl.exe -fsSL -o overheard.zip https://codeload.github.com/TrellaceTeam/overheard-ai/zip/refs/heads/main
tar -xf overheard.zip overheard-ai-main/lite/kit
Copy-Item -Path overheard-ai-main\lite\kit\* -Destination . -Recurse -Force
Remove-Item overheard.zip
Remove-Item overheard-ai-main -Recurse
```

Check that the folder now holds `.claude`, `.agents` and `.codex`.

## 4. Set it up

Read the `SKILL.md` for your app: `.claude/skills/overheard/SKILL.md` in Claude Code, `.agents/skills/overheard/SKILL.md` in Codex. Follow its [setup](kit/.agents/skills/overheard/references/setup.md) now, in this session. Start with one line, such as "Got it. Setup takes about five minutes." Then ask for the website.

Setup ends with the first run in a fresh session, because the helper that asks the questions loads only when a session starts.

## Update it later

The person can ask: "Update Overheard Lite in this folder from https://github.com/TrellaceTeam/overheard-ai/tree/main/lite."

Do step 3 again. The kit holds no `overheard.json`, `runs` or `dashboard.html`, so the setup and every past run stay as they are. Then run `python <script> build` so the dashboard picks up any change in how it's drawn.
