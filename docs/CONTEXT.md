# Overheard AI

A local app that asks AI assistants questions about a market and measures how often, and how, they mention a brand and its competitors.

## Language

### Projects and brands

**Project**:
One brand being monitored, with its competitors, prompts, assistants and history of runs.
_Avoid_: workspace, account

**Own brand**:
The brand a project is about. Stored as the project's target brand, with a name and variants.
_Avoid_: target (in UI text), client, user brand

**Brand description**:
The optional one-sentence answer at project setup to what the brand does, for whom and where; it exists to tailor the starter prompts and nothing else reads it yet.
_Avoid_: about text, positioning statement

**Competitor**:
Another brand in the same project. Either **tracked** (added by the user) or **discovered** (found in answers).
_Avoid_: rival, alternative

**Demo project**:
A built-in, read-only project about a real company, with invented history, used to show what the app looks like with data. It is never run.
_Avoid_: sample project, example project, fake project

**Showcase run**:
The one generated run of the demo project the tutorial tour opens on: its newest weekly run, every call collected, showing what the run page looks like once a run of your own has finished.
_Avoid_: demo run (ambiguous with a run made in mock mode), sample run

### Asking

**Prompt**:
A question the project asks every selected assistant on each run. Answers to prompts feed the statistics, except self-referenced prompts.
_Avoid_: query, question (for stored prompts)

**Starter prompts**:
The prompts proposed at onboarding, filled in from the brand and category, which the user can edit, or have rewritten once to fit the brand by one call on their own key.
_Avoid_: suggested questions, default prompts

**Self-referenced prompt**:
A prompt whose text names the own brand or one of its variants. It is asked and its answers are kept, but it never counts in any statistic, for the own brand or competitors.
_Avoid_: brand-named prompt, self-ref prompt

**Perception prompt**:
The single, separate question that asks each assistant what it knows about the own brand. Its answers are summarized, never counted in statistics.
_Avoid_: perception question

**Perception check**:
The perception-only run, one ask of every monitored assistant, producing no measurement, and its status in the dashboard's perception band, which is where its failures are shown and retried.
_Avoid_: perception run (in UI text)

**Run**:
One round of asking every active prompt to every selected assistant, then extracting brands from the answers.
_Avoid_: scan, job, crawl

**Answer summary**:
A short, on-demand AI summary of what the assistants answered to one prompt in one run (e.g. "8 of 10 answers say…"). Never counted in statistics.
_Avoid_: average answer, prompt summary

**Prompt results summary**:
A short, on-demand AI summary of everything the assistants have answered to one prompt across all runs, newest first. Bought and stored per prompt; asking again replaces it. Never counted in statistics.
_Avoid_: prompt summary (ambiguous between the two), aggregate summary, cross-run summary

**Outdated summary**:
A prompt results summary written before the latest finished run with answers for its prompt. It is flagged and offers a re-ask; it is never replaced or re-bought automatically.
_Avoid_: stale summary (in user-facing text)

### Running

**Runner**:
The block at the top of the Prompts tab that holds which assistants a run asks, what the next run will collect and cost, and the button that starts it.
_Avoid_: run bar, launch panel

**Extraction ladder**:
The invisible order of readers a stored answer climbs when the extraction model replies in the wrong shape: the same provider's next tier up, then the cheapest extractor whose provider has a key, two escalations at most, every attempt logged like any extraction call. Only an exhausted ladder fails the answer.
_Avoid_: fallback chain, retry ladder

### Measuring

**Setup check**:
The check, before a project is created, that each selected assistant answers with web search using the user's key, and that the extractor works. It names the exact reason for any failure (bad key, no budget or billing, search disabled, model unavailable…).
_Avoid_: key test, key check

**Statistics**:
The numbers derived from answers to prompts that are not self-referenced: mention rate, citation rate, top-3 rate, rank and share of voice.
_Avoid_: metrics (in UI text), KPIs

**Denominator**:
The answers a statistic is out of: successful answers to prompts that are not self-referenced, in every assistant and prompt pair where at least one brand was named. A pair whose answers name no brand at all counts for no brand, because it says nothing about how brands compare.
_Avoid_: sample, total answers

### Settings

**Account settings**:
The machine's screen: provider keys read from the environment, the run size limit, each provider's calls in flight, the database and its backups, the worker, and the demo project. Keys live here and only here, because they belong to the install, not to a project.
_Avoid_: app settings, general settings, Settings (ambiguous with the project's)

**Project settings**:
One project's screen: its brand and variants, perception prompt, schedule, extractor and extraction prompt, and its deletion. Which assistants a run asks lives in the Runner, not here.
_Avoid_: Settings (ambiguous with the machine's)

### First launch

**Tutorial**:
The guided walk-through shown on first launch, or when started from Settings: one popup tour from the first setup field to the last door. It guides the locked setup screen, then tours the demo project's results.
_Avoid_: tour (for the whole thing), onboarding, walkthrough
