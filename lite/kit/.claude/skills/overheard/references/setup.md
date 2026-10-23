# Set up Overheard Lite

Setup takes about five minutes. Ask one question, do the research yourself, then propose the whole setup in one message and act on one yes. The person may not be technical, so explain each step in plain words and give them every click.

## 1. Check the folder

- **One folder per brand and per assistant.** It holds only the kit and what Overheard writes. When the session's folder holds other work, such as a code project, ask the person to make an empty folder, open it in the app, and paste the line they started with.
- **A plain name.** Every helper sees the folder's path, so a name like `Overheard` is best. When the name contains the brand, say so and suggest a plain name. They can rename it before the first run.
- **Not inside a Git repository.** A scheduled task in a Git repository can run in a separate copy of the folder and leave its results there. When `git rev-parse` finds a repository, suggest a folder outside it.
- **Which assistant.** Claude Code measures Claude. Codex measures ChatGPT. Note which one you are.

### Python

Find Python as SKILL.md says. When none prints 3.9 or later, explain that Overheard Lite uses it to count the answers and build the dashboard, then ask before you install it:

- Windows: `winget install -e --id Python.Python.3.13`, then open a new terminal or session.
- Mac: `xcode-select --install`, which adds `python3`, or the installer from python.org.

## 2. Ask for the website

Ask one question: "What's your company's website?" Then read the site and search the web yourself for the items below. When the app blocks web search or fetching, ask the person to allow them, since setup and every run need them.

- the brand's name, any other names buyers use, such as a short name or the main product's name, and its domains
- one sentence on what it does, for whom and where
- 3 to 5 competitors a buyer would weigh against it, each with its domain

## 3. Propose the whole setup

Draft 6 buyer questions. These rules are Overheard AI's own:

- 4 questions a buyer asks while looking for options, and 2 a buyer asks while weighing options against each other. None names the brand, its other names or a competitor, because the point is whether the assistant brings the brand up unprompted.
- Make each one specific to what the brand does: its audience, its place and its use case. A business that serves one city gets questions about that city.
- Write each the way a buyer would type it: plain words, one or two sentences, ending with a question mark. Never tell the assistant how to answer: no instructions to search, browse, cite or format.
- Invent no facts about the brand, a place or a price.

Then send one message with:

1. The brand, its other names, its domains and the one sentence.
2. The competitors and their domains.
3. The 6 questions.
4. The run size: each question asked twice, plus one question about the brand, so 13 helpers a run. Each helper searches the web, so a run takes several minutes and counts against the plan's usage limits like a long chat. Fewer repeats use less. More give steadier numbers.
5. How often to run: ask whether they want it to run on its own, and how often, such as every week or every month, or only when they ask. Don't assume.
6. Two things that can tilt answers: the folder's name, and in Claude Code the email the app is signed in with, which Claude Code shares with the model. An email at the brand's own domain can nudge answers toward the brand. A separate account with a neutral email avoids it.

Ask: "Shall I set it up like this?" Take their edits, then do everything below without asking again.

## 4. Save the setup

Write `overheard.json` in the Overheard folder:

```json
{
  "assistant": "claude",
  "brand": {
    "name": "Acme Analytics",
    "other_names": ["Acme"],
    "domains": ["example.com"],
    "description": "Dashboards for small retail teams in the UK."
  },
  "competitors": [
    { "name": "Northwind Metrics", "other_names": [], "domains": ["northwind.example.com"] }
  ],
  "questions": [
    { "id": "q01", "text": "What are the best analytics tools for a small retail team in the UK?" }
  ],
  "repeats": 2,
  "perception": true
}
```

`assistant` is `claude` or `chatgpt`. Question ids are `q01`, `q02` and so on. When a question is removed later, its id is never reused, so old runs stay readable. Run `python <script> setup-check` and fix every problem it lists.

## 5. Set the schedule

Skip this when they want to run it only when they ask.

Use this prompt for the task, word for word:

```
Run Overheard in this folder with the overheard skill. Follow its run steps and ask me nothing. End with the summary its build prints.
```

- **Claude app, Code tab.** When you have a tool that creates scheduled tasks, create a local task named `Overheard`, in this folder, on their schedule, with that prompt. Otherwise give them the steps: open **Scheduled** in the Code tab's sidebar, click **New task**, then **Set up manually**. Name it `Overheard` and paste the prompt. Under **Advanced settings**, turn on **Only on this computer** and pick this folder. Pick the schedule, then click **Create**.
- **ChatGPT app, Codex.** When you can create scheduled tasks, create a standalone task for this project, on their schedule, with that prompt. Otherwise ask them to open **Scheduled** in the sidebar and add a task for this project with that prompt and schedule.
- **A terminal only.** Give them the line for their system's scheduler, run in this folder: `claude -p "<the prompt>"` or `codex exec "<the prompt>"`.

Tell them scheduled runs happen only while the app is open and the computer is awake. A run missed while the computer slept happens once when it wakes.

## 6. Start the first run in a fresh session

The helper agent loads when a session starts, so the first run happens in a new session, not this one. Both apps read this folder's settings and its helper only once the person trusts the folder. The apps ask when the folder is opened or the task is created. In a terminal, they run `claude` or `codex` once in the folder and accept the trust question.

- With a schedule in the Claude or ChatGPT app: ask them to open the task and click **Run now**. When the run stops to ask permission for a step, they choose to always allow it, so later runs never stall.
- Otherwise: ask them to start a new session in this folder and paste this line:

```
Run Overheard in this folder with the overheard skill.
```

Close with what happens next: the run takes several minutes, then `dashboard.html` in this folder shows the results. They can open it in any browser.
