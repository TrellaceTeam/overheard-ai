# Screenshots

The images the project README shows, and how to take them again.

Every file except the banner is one 1440x900 viewport at 1x, captured with headless Chrome
through the DevTools protocol, with the page locale set to en-US. Overheard AI has one theme and
it is dark, so there is no light version of these.

| File | Screen | What it shows |
| --- | --- | --- |
| `00-banner.png` | `/projects/:id`, demo project | A 1144x447 crop of the dashboard's Visibility over time card: mention, top 3 and citation rates across the demo's 26 weekly runs. It names no company. |
| `02-run.png` | `/projects/:id/runs/:runId`, demo project | The demo's newest weekly run, finished: all 36 answers collected, estimated spend on your own keys, and the Results tab with Ramp's rates in this run above the competitor table. |
| `03-dashboard.png` | `/projects/:id`, demo project | The dashboard scrolled to its three rate cards, with the six-month trend and the head-to-head with Brex below them. |
| `04-prompts.png` | `/projects/:id/prompts`, demo project | The Runner, locked because the demo is browse-only and no key is set, with its plan line and estimated cost, above the new prompt form. |
| `05-competitors.png` | `/projects/:id/competitors`, demo project | Add a competitor, and the tracked competitor cards for Navan and Mercury with their rates, name variants and domains. |

## Real names

The images name real companies: Ramp and its competitors Brex, Navan and Mercury. The demo's
data is generated from a fixed seed, so nothing in them was measured.
[ADR 0006](../decisions/0006-demo-project-uses-real-brand-names.md), as amended on 2026-09-26,
allows them here and lets the screenshots leave the in-app demo notice and the browse-only note
out; the app itself keeps showing both on every demo page.

The Account settings screen (`/settings`) is not pictured on purpose: it prints the absolute
path of the database file, which on any real machine contains a username.

## Retaking these

1. Start on a scratch database, with no provider keys in the environment, so the Runner shows
   the locked state. Delete `data/readme.db` and its `-wal` and `-shm` files first.

   ```sh
   PORT=3018 DATABASE_PATH=./data/readme.db npm run dev
   ```

2. Open http://127.0.0.1:3018. A new database opens the tutorial: walk it or press Skip ahead,
   and choose Explore demo project on the last popup. That builds the demo project and marks
   the tutorial done, so it stays out of the way.
3. Set the viewport to 1440x900 at 1x and the locale to en-US. On every demo page, hide the
   demo notice and the browse-only note under the tabs before capturing, for example with this
   in the console:

   ```js
   document.querySelector('[data-tour="demo-notice"]').style.display = "none";
   for (const note of document.querySelectorAll('p[role="note"]'))
     if (note.textContent.startsWith("The demo project is browse-only")) note.style.display = "none";
   ```

   Then shoot:
   - `02-run.png`: the demo's newest weekly run, which is where the tutorial's results half
     starts, at the top of the page.
   - `03-dashboard.png`: the dashboard scrolled until its three rate cards sit just under the
     header, so the frame holds the cards, the six-month trend and the head-to-head with
     competitors.
   - `04-prompts.png` and `05-competitors.png`: the Prompts and Competitors tabs, at the top of
     each page.
   - `00-banner.png`: a crop of the dashboard's Visibility over time heading and card, with a
     20 pixel margin.

Retake an image whenever a screen or a string it shows changes. Keep the file names, since the
README points at them, and update this table and the README's alt text to match.
