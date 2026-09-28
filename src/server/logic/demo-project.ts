/**
 * The demo project generator (ADR 0006).
 *
 * ensureDemoProject creates a built-in project about a real company (Ramp) with
 * real competitors (Brex, Navan, Mercury) and 26 weeks of invented history, or
 * returns the existing demo's id. Every run is marked mock, every number is
 * generated here, and the app labels the project as invented data wherever it
 * is shown. This module and its tests are where real brand names are allowed:
 * CONTRIBUTING.md's fictional-brands rule excepts them under ADR 0006.
 *
 * The generator is deterministic: a fixed-seed PRNG drives every roll, so two
 * databases created on the same day hold the same story. Run ids come from the
 * seed too (lib/demo-ids.ts), because the tour opens the showcase run, the
 * newest weekly run, by id. Only the dates vary: the history ends at the last
 * noon UTC before creation, so a demo restored months later still reads as
 * "the last six months".
 *
 * Every call in the history succeeds, the showcase run included. A demo that
 * shows something failing reads as a product that fails.
 *
 * Statistics are not hand-written. Answers, extractions and observations are
 * fabricated under their week's dates, then the real finalisation
 * (finalizeRun) scores them, so the demo's numbers come from the same pipeline
 * as a real project's.
 *
 * The story: Ramp starts barely mentioned, rises slowly, jumps in week 15
 * after a fictional press moment and settles higher, with its rank improving.
 * Brex stays high and steady, Navan flat, Mercury dips slightly.
 */
import { randomUUID } from "node:crypto";
import type { Driver } from "../db/driver";
import { DEMO_SEED, DEMO_WEEKS, demoRunId, prng } from "@/lib/demo-ids";
import { resolvePerceptionPrompt } from "@/lib/perception";
import { finalizeRun } from "./finalize-run";
import { writePerceptionSummary } from "./perception-summary";

/* ------------------------------------------------------------ the roster */

/** Real names with invented data, allowed by ADR 0006. */
export const DEMO_BRAND = { name: "Ramp", domain: "ramp.com" };
export const DEMO_COMPETITORS = [
  { name: "Brex", domain: "brex.com" },
  { name: "Navan", domain: "navan.com" },
  { name: "Mercury", domain: "mercury.com" },
] as const;

export { DEMO_WEEKS };
/** 1-based: the week of the jump the tour's chart step describes. */
export const DEMO_JUMP_WEEK = 15;
/**
 * Iterations per prompt per run. One would give 12 answers a week, too coarse
 * a sample. The served statistics exclude the self-referenced prompt, leaving
 * 27 answers a week, which keeps the week-15 jump clearly larger than a week's
 * sampling noise.
 */
export const DEMO_ITERATIONS = 3;

/** The assistants the demo "asked", by catalog model_id (resolved to ids at run time). */
const DEMO_ASSISTANT_MODELS = ["claude-sonnet-5", "gpt-6-sol", "gemini-3.8-flash"];
const DEMO_EXTRACTOR_MODEL = "gpt-6-luna";

/**
 * The prompts. One names the brand, so the dashboard's exclusion of
 * self-referenced prompts is visible in the demo too: its answers exist and can
 * be read on the run page, but never count in the statistics.
 */
export const DEMO_PROMPTS = [
  {
    text: "What are the best corporate card and spend management platforms for mid-sized companies?",
    category: "visibility",
  },
  {
    text: "How do finance teams automate expense management and keep control of company spending?",
    category: "process",
  },
  {
    text: "Which fintech platforms would you recommend for a growing company's finance stack?",
    category: "visibility",
  },
  {
    text: "How does Ramp compare with other spend management platforms on expense automation?",
    category: "comparison",
  },
];

/* ------------------------------------------------------- deterministic rng */

/** An integer in [low, high], inclusive. */
function between(rand: () => number, low: number, high: number): number {
  return low + Math.floor(rand() * (high - low + 1));
}

/* ------------------------------------------------------------ the story */

interface BrandArc {
  name: string;
  domain: string;
  /** Probability this brand is mentioned in one answer, by week index (0 = oldest). */
  mention: (week: number) => number;
  /** Inclusive position range when mentioned; lower is better. */
  position: (week: number) => [number, number];
  /** Probability a mention carries a citation to the brand's domain. */
  citation: number;
}

const JUMP = DEMO_JUMP_WEEK - 1; // week index of the press-moment run

const ARCS: BrandArc[] = [
  {
    name: DEMO_BRAND.name,
    domain: DEMO_BRAND.domain,
    // Slow climb, then the jump: from about 0.12 to 0.22 over the first 14
    // weeks, then straight to about 0.62, settling a little higher. The step is
    // several times a week's sampling noise, so it shows in the jump week
    // itself, not just in the averages around it.
    mention: (week) =>
      week < JUMP ? 0.12 + 0.008 * week : Math.min(0.62 + 0.004 * (week - JUMP), 0.7),
    position: (week) => (week < JUMP ? [3, 7] : [1, 4]),
    citation: 0.5,
  },
  {
    name: DEMO_COMPETITORS[0].name,
    domain: DEMO_COMPETITORS[0].domain,
    mention: () => 0.78,
    position: () => [1, 3],
    citation: 0.55,
  },
  {
    name: DEMO_COMPETITORS[1].name,
    domain: DEMO_COMPETITORS[1].domain,
    mention: () => 0.45,
    position: () => [2, 5],
    citation: 0.4,
  },
  {
    name: DEMO_COMPETITORS[2].name,
    domain: DEMO_COMPETITORS[2].domain,
    mention: (week) => 0.55 - 0.008 * week,
    position: () => [2, 5],
    citation: 0.4,
  },
];

/* ------------------------------------------------------------- date maths */

/**
 * The latest noon UTC at or before `now`. Noon, so no timezone or day boundary
 * can shift a demo date. At or before, so the newest run is never in the future.
 */
function lastNoon(now: Date): Date {
  const noon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
  return noon.getTime() <= now.getTime() ? noon : minusDays(noon, 1);
}

function minusDays(date: Date, days: number): Date {
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
}

function plusMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

/* ---------------------------------------------------------- one answer */

interface DemoMention {
  arc: BrandArc;
  position: number;
  cited: boolean;
}

/**
 * Roll one answer for one (prompt, assistant, week): which brands appear, in
 * what order, with which citations. The self-referenced prompt asks about the
 * project's own brand, so its answer always includes it. The statistics
 * exclude that prompt server-side.
 */
function rollMentions(rand: () => number, week: number, selfReferenced: boolean): DemoMention[] {
  const mentions: DemoMention[] = [];
  for (const arc of ARCS) {
    const isOwn = arc.name === DEMO_BRAND.name;
    const p = selfReferenced && isOwn ? 1 : arc.mention(week);
    if (rand() >= p) continue;
    const [low, high] = arc.position(week);
    const cited = rand() < arc.citation;
    mentions.push({ arc, position: between(rand, low, high), cited });
  }
  // Distinct slots in the ranked list, best rolled position first.
  mentions.sort((a, b) => a.position - b.position || a.arc.name.localeCompare(b.arc.name));
  return mentions.map((mention, index) => ({ ...mention, position: index + 1 }));
}

/** The answer text a person would read on the run page. */
function answerText(promptText: string, mentions: DemoMention[]): string {
  if (mentions.length === 0) {
    return `I could not find a confident recommendation for that question. "${promptText}" drew mostly general advice about budgeting processes rather than named platforms.`;
  }
  const list = mentions
    .map((mention) => {
      const label = mention.cited
        ? `[${mention.arc.name}](https://${mention.arc.domain}/)`
        : mention.arc.name;
      return `${mention.position}. ${label}`;
    })
    .join(", ");
  return `Based on current discussions and reviews, the platforms that come up for this question are: ${list}. The order reflects how often each name leads recommendations and how strongly reviewers rate its automation and controls.`;
}

/* --------------------------------------------------------- the generator */

interface CatalogModel {
  id: string;
  provider: string;
  model_id: string;
}

function catalogModel(db: Driver, modelId: string): CatalogModel {
  const row = db
    .prepare("SELECT id, provider, model_id FROM models WHERE model_id = ? AND is_active = 1")
    .get<CatalogModel>(modelId);
  if (!row) throw new Error(`DEMO_MODEL_MISSING: ${modelId} is not in the catalog`);
  return row;
}

export interface EnsureDemoProjectOptions {
  /** Injectable for tests: the history ends at the last noon UTC at or before it. Defaults to now. */
  today?: Date;
}

export interface DemoProjectResult {
  projectId: string;
  /** False when the demo already existed and nothing was written. */
  created: boolean;
}

/**
 * The demo project, created if missing. Idempotent: with a demo present this
 * is a read. The database enforces "at most one" with a partial unique index,
 * so a race cannot duplicate it.
 */
export function ensureDemoProject(
  db: Driver,
  options: EnsureDemoProjectOptions = {},
): DemoProjectResult {
  const existing = db.prepare("SELECT id FROM projects WHERE is_demo = 1").get<{ id: string }>();
  if (existing) return { projectId: existing.id, created: false };
  return { projectId: generateDemoProject(db, options.today ?? new Date()), created: true };
}

function generateDemoProject(db: Driver, today: Date): string {
  const rand = prng(DEMO_SEED);
  const projectId = randomUUID();
  const lastWeek = lastNoon(today);
  /** Week index 0 is the oldest run; the newest is `lastWeek`. */
  const weekDate = (week: number): Date => minusDays(lastWeek, (DEMO_WEEKS - 1 - week) * 7);

  const assistants = DEMO_ASSISTANT_MODELS.map((modelId) => catalogModel(db, modelId));
  const extractor = catalogModel(db, DEMO_EXTRACTOR_MODEL);
  const extractorUsed = `${extractor.provider}/${extractor.model_id}`;

  const firstDay = minusDays(weekDate(0), 1);

  db.prepare(
    `INSERT INTO projects (id, name, extraction_model_id, is_demo, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
  ).run(projectId, DEMO_BRAND.name, extractor.id, firstDay.toISOString(), firstDay.toISOString());

  const brandIds = new Map<string, string>();
  const insertBrand = (name: string, domain: string, role: "target" | "competitor"): void => {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO brands (id, project_id, name, role, variants, domains, suggested_domains, created_at)
       VALUES (?, ?, ?, ?, '[]', ?, '[]', ?)`,
    ).run(id, projectId, name, role, JSON.stringify([domain]), firstDay.toISOString());
    brandIds.set(name, id);
  };
  insertBrand(DEMO_BRAND.name, DEMO_BRAND.domain, "target");
  for (const competitor of DEMO_COMPETITORS) {
    insertBrand(competitor.name, competitor.domain, "competitor");
  }

  const promptRows = DEMO_PROMPTS.map((prompt) => {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO prompts (id, project_id, text, category, iterations, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      projectId,
      prompt.text,
      prompt.category,
      DEMO_ITERATIONS,
      firstDay.toISOString(),
      firstDay.toISOString(),
    );
    const selfReferenced = prompt.text.includes(DEMO_BRAND.name);
    return { id, text: prompt.text, selfReferenced };
  });

  for (const assistant of assistants) {
    db.prepare("INSERT INTO project_models (project_id, model_id) VALUES (?, ?)").run(
      projectId,
      assistant.id,
    );
  }

  const perceptionPrompt = db
    .prepare("SELECT perception_prompt FROM projects WHERE id = ?")
    .get<{ perception_prompt: string }>(projectId)!.perception_prompt;
  const perceptionQuestion = resolvePerceptionPrompt(perceptionPrompt, DEMO_BRAND.name);

  for (let week = 0; week < DEMO_WEEKS; week++) {
    const day = weekDate(week);
    insertMeasuredRun(db, {
      projectId,
      rand,
      week,
      day,
      prompts: promptRows,
      assistants,
      extractorUsed,
      brandIds,
    });
  }

  insertPerceptionRun(db, {
    projectId,
    day: weekDate(DEMO_WEEKS - 1),
    assistants,
    question: perceptionQuestion,
  });

  return projectId;
}

interface MeasuredRunInput {
  projectId: string;
  rand: () => number;
  week: number;
  day: Date;
  prompts: Array<{ id: string; text: string; selfReferenced: boolean }>;
  assistants: CatalogModel[];
  extractorUsed: string;
  brandIds: Map<string, string>;
}

/**
 * One weekly run: the rows a real run would have once its worker pass is done,
 * dated to its week and scored by the real finalisation. started_at and
 * finished_at are written before finalising because updateRunProgress keeps
 * stored timestamps and writes `now` only into null ones.
 */
function insertMeasuredRun(db: Driver, input: MeasuredRunInput): void {
  const { projectId, rand, week, day, prompts, assistants, extractorUsed, brandIds } = input;
  const runId = demoRunId(week);
  const taskCount = prompts.length * assistants.length * DEMO_ITERATIONS;

  db.prepare(
    `INSERT INTO runs (id, project_id, trigger, status, planned_calls, completed_calls, failed_calls,
                       config_snapshot, started_at, finished_at, created_at, mock)
     VALUES (?, ?, 'scheduled', 'queued', ?, 0, 0, '{}', ?, ?, ?, 1)`,
  ).run(
    runId,
    projectId,
    taskCount * 2,
    plusMinutes(day, 1).toISOString(),
    plusMinutes(day, 6).toISOString(),
    day.toISOString(),
  );

  prompts.forEach((prompt) => {
    assistants.forEach((assistant) => {
      for (let iteration = 1; iteration <= DEMO_ITERATIONS; iteration++) {
        const taskId = randomUUID();
        // Tasks draw from the seeded PRNG in a fixed order, so the story is
        // identical between builds.
        const mentions = rollMentions(rand, week, prompt.selfReferenced);
        const answer = answerText(prompt.text, mentions);
        const tokens = between(rand, 320, 640);
        const latency = between(rand, 2400, 9000);

        db.prepare(
          `INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration, question_text,
                                  is_perception, status, attempts, next_attempt_at,
                                  answer_text, answer_tokens, latency_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'done', 1, ?, ?, ?, ?, ?)`,
        ).run(
          taskId,
          runId,
          projectId,
          prompt.id,
          assistant.id,
          iteration,
          prompt.text,
          day.toISOString(),
          answer,
          tokens,
          latency,
          day.toISOString(),
        );

        db.prepare(
          `INSERT INTO extractions (id, run_task_id, project_id, answer_format, total_items, raw_json, model_used, created_at)
           VALUES (?, ?, ?, 'ranked_list', ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          taskId,
          projectId,
          mentions.length,
          JSON.stringify({
            format: "ranked_list",
            items: mentions.map((mention) => ({
              name: mention.arc.name,
              position: mention.position,
              url: mention.cited ? `https://${mention.arc.domain}/` : null,
            })),
          }),
          extractorUsed,
          day.toISOString(),
        );

        for (const mention of mentions) {
          db.prepare(
            `INSERT INTO brand_observations (id, run_task_id, run_id, project_id, brand_id, raw_name,
                                             position, total_items, mention_type, linked_url, is_cited, evidence, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ranked', ?, ?, ?, ?)`,
          ).run(
            randomUUID(),
            taskId,
            runId,
            projectId,
            brandIds.get(mention.arc.name) ?? null,
            mention.arc.name,
            mention.position,
            mentions.length,
            mention.cited ? `https://${mention.arc.domain}/` : null,
            mention.cited ? 1 : 0,
            `Ranked #${mention.position} among ${mentions.length} recommended platforms.`,
            day.toISOString(),
          );
        }
      }
    });
  });

  // The real pipeline computes every statistic the dashboard shows.
  finalizeRun(db, runId);
}

interface PerceptionRunInput {
  projectId: string;
  day: Date;
  assistants: CatalogModel[];
  question: string;
}

/**
 * One perception run on the newest week, plus the summaries the dashboard's
 * perception card reads: one row per assistant and the merged row. The stored
 * question_text equals the project's current resolved prompt, so the card
 * never shows a staleness badge.
 *
 * The section text draws on what is publicly on the record about the brand,
 * widely published praise and criticism (ADR 0006). It invents no events,
 * dates or numbers, and the downsides section reports commonly published
 * criticisms in neutral phrasing instead of staying empty. Each assistant gets
 * its own wording because three identical rows read as canned. The merged row
 * is the synthesis the band shows by default.
 */
function insertPerceptionRun(db: Driver, input: PerceptionRunInput): void {
  const { projectId, day, assistants, question } = input;
  const runId = demoRunId(DEMO_WEEKS);

  db.prepare(
    `INSERT INTO runs (id, project_id, trigger, status, planned_calls, completed_calls, failed_calls,
                       config_snapshot, started_at, finished_at, created_at, mock)
     VALUES (?, ?, 'manual', 'queued', ?, 0, 0, '{"perception_only": true}', ?, ?, ?, 1)`,
  ).run(
    runId,
    projectId,
    assistants.length * 2,
    plusMinutes(day, 7).toISOString(),
    plusMinutes(day, 11).toISOString(),
    day.toISOString(),
  );

  const flavours = [
    "recognizes it as a spend management platform and describes its card, expense automation and bill pay features",
    "knows the brand and summarizes its corporate card, spending controls and accounting integrations offering",
    "identifies it as a finance platform for companies and outlines its main product areas",
  ];

  assistants.forEach((assistant, index) => {
    db.prepare(
      `INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration, question_text,
                              is_perception, status, attempts, next_attempt_at,
                              answer_text, answer_tokens, latency_ms, created_at)
       VALUES (?, ?, ?, NULL, ?, 1, ?, 1, 'done', 1, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      runId,
      projectId,
      assistant.id,
      question,
      day.toISOString(),
      `Yes. This assistant ${flavours[index % flavours.length]}, aimed at finance teams at startups and mid-sized companies.`,
      180 + index * 30,
      3000 + index * 500,
      day.toISOString(),
    );
  });

  const perAssistant = [
    {
      what_it_does:
        "Ramp is a corporate card and spend management platform for United States businesses. It combines physical and virtual cards with expense management, bill pay, purchasing controls, and accounting integrations in one system.",
      typical_customers:
        "Finance teams at startups, small businesses, and midsize companies, along with accountants and operations leaders who want card spend and expenses in one place.",
      well_regarded_for:
        "Ease of use, a modern interface, granular card and spend controls, automated receipt collection, and real-time spend visibility that saves lean finance teams manual work.",
      downsides:
        "Users most often cite support that is chat- and email-heavy and slow on complex issues, and cash-flow-based underwriting that can lower a credit limit without warning when connected balances drop.",
    },
    {
      what_it_does:
        "Ramp is a spend management and financial automation platform built around corporate charge cards, covering expenses, reimbursements, accounts payable, vendor management, and travel booking, with some cash management services alongside.",
      typical_customers:
        "Organizations from startups to enterprises, especially in software, financial services, construction, healthcare, and professional services, with finance and operations teams as the day-to-day users.",
      well_regarded_for:
        "Time-saving automation, policy enforcement, virtual cards, spend visibility, cashback value, and fast implementation compared with older expense tools.",
      downsides:
        "Recurring criticisms include short settlement schedules, cashback terms that some users find unclear, reporting and advanced administration that can be hard to learn, and edge cases around out-of-pocket reimbursements.",
    },
    {
      what_it_does:
        "Ramp is a finance platform for companies centered on corporate cards and expense automation, and it extends into bill pay, procurement, travel, and integrations with accounting software.",
      typical_customers:
        "Finance teams and accountants at startups and mid-market companies, including nonprofits, education, hospitality, retail, and ecommerce organizations.",
      well_regarded_for:
        "Automated expense workflows, built-in spending controls, receipt matching, and a simple enough setup that smaller teams can run it without a dedicated administrator.",
      downsides:
        "Users report that procurement features and multi-entity workflows can feel limited for larger enterprises, and that account reviews and limit changes driven by daily balance monitoring sometimes arrive without notice.",
    },
  ];

  const merged = {
    what_it_does:
      "Ramp is a United States spend management platform centered on corporate charge cards. It combines physical and virtual cards with expense management, bill pay, accounts payable, procurement, travel booking, and accounting integrations in one system.",
    typical_customers:
      "Finance teams, accountants, and operations leaders at startups, small businesses, and midsize companies, across industries from software and financial services to construction, healthcare, hospitality, and nonprofit work.",
    well_regarded_for:
      "Ease of use, a modern interface, granular card and spend controls, automated receipt collection, real-time spend visibility, time-saving expense automation, cashback value, and fast implementation.",
    downsides:
      "Most often cited are support that is chat- and email-heavy and slow on complex issues, cash-flow-based underwriting that can lower credit limits when connected balances drop, short settlement schedules, cashback terms some users find unclear, and procurement and multi-entity workflows that larger enterprises can outgrow.",
  };

  assistants.forEach((assistant, index) => {
    writePerceptionSummary(db, projectId, assistant.id, {
      knows_brand: true,
      ...perAssistant[index % perAssistant.length]!,
      run_id: runId,
      question_text: question,
      source_answers: 1,
    });
  });

  writePerceptionSummary(db, projectId, null, {
    knows_brand: true,
    ...merged,
    run_id: runId,
    question_text: question,
    source_answers: assistants.length,
  });

  finalizeRun(db, runId);
}
