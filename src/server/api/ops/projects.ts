/**
 * Projects: the list, the settings a project carries, and creating one when
 * the setup wizard finishes.
 *
 * createProject writes projects, brands, prompts and project_models in one
 * transaction, so a failed statement leaves no half-made project behind.
 */
import type { Driver } from "../../db/driver";
import type { ProjectRow } from "../../db/types";
import { isPlausibleDomain, normalizeDomain } from "@/lib/brand-matching";
import {
  DEFAULT_WIZARD_ITERATIONS,
  DESCRIPTION_MAX_CHARS,
  MAX_WIZARD_ITERATIONS,
  MIN_WIZARD_ITERATIONS,
  normalizeDescription,
  pickExtractor,
  starterPrompts,
} from "@/lib/onboarding";
import { allRowsPassed } from "@/lib/setup-check";
import { checkSelection, type SetupCheckRow, type SetupProbe } from "./setup-check";
import { PERCEPTION_TEMPLATE, perceptionEnabled } from "@/lib/perception";
import { EXTRACTION_SYSTEM } from "../../worker/extraction";
import { listExtractionModels } from "./models";
import {
  encodeList,
  expectChanged,
  InvalidInputError,
  newId,
  NotFoundError,
  nowIso,
  refuseDemoProject,
} from "./shared";

export interface ProjectListItem {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSettings {
  id: string;
  name: string;
  extractionModelId: string | null;
  perceptionPrompt: string;
  /** The prompt this project's extraction calls use. The default until edited. */
  extractionPrompt: string;
  /** The prompt Reset to default restores: the constant in code, not the migration's copy. */
  extractionPromptDefault: string;
}

/**
 * Oldest first, so the switcher does not reorder itself as projects are used.
 * Two projects created in the same millisecond share created_at, so rowid
 * breaks the tie. It follows insertion order and a random id does not.
 */
export function listProjects(db: Driver): ProjectListItem[] {
  return db
    .prepare(
      `SELECT id, name, created_at AS createdAt, updated_at AS updatedAt
         FROM projects ORDER BY created_at, rowid`,
    )
    .all<ProjectListItem>();
}

/**
 * The most recently touched project, which is where / sends a returning user.
 * Same tiebreak as listProjects, reversed, so a tie opens the newest project
 * rather than an arbitrary one.
 */
export function mostRecentProjectId(db: Driver): string | null {
  const row = db
    .prepare(
      "SELECT id FROM projects ORDER BY updated_at DESC, created_at DESC, rowid DESC LIMIT 1",
    )
    .get<{ id: string }>();
  return row?.id ?? null;
}

/**
 * The project shell's facts: its name for the header, and whether it is the
 * built-in demo, which every page of the project needs in order to carry the
 * invented-data notice.
 */
export function getProject(
  db: Driver,
  projectId: string,
): { id: string; name: string; isDemo: boolean } {
  const row = db
    .prepare("SELECT id, name, is_demo FROM projects WHERE id = ?")
    .get<{ id: string; name: string; is_demo: number }>(projectId);
  if (!row) throw new NotFoundError("PROJECT_NOT_FOUND", "that project does not exist");
  return { id: row.id, name: row.name, isDemo: row.is_demo === 1 };
}

export function getProjectSettings(db: Driver, projectId: string): ProjectSettings {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get<ProjectRow>(projectId);
  if (!row) throw new NotFoundError("PROJECT_NOT_FOUND", "that project does not exist");
  return {
    id: row.id,
    name: row.name,
    extractionModelId: row.extraction_model_id,
    perceptionPrompt: row.perception_prompt,
    extractionPrompt: row.extraction_prompt,
    extractionPromptDefault: EXTRACTION_SYSTEM,
  };
}

export interface CreateProjectInput {
  /** The brand being watched. Also the project name unless one is given. */
  brandName: string;
  /** Free text, for example a category of software. Shapes the starter prompts. */
  category?: string | undefined;
  /**
   * The brand description: one optional sentence on what the brand does, for
   * whom and where. Stored normalised, and null when blank.
   */
  description?: string | undefined;
  projectName?: string | undefined;
  variants?: string[] | undefined;
  /** At least one, each plausible. A brand with no domain can never be cited. */
  domains: string[];
  /**
   * A bare name or a name with domains. Domains are optional. A competitor
   * without one still has its mentions counted, but its citation rate stays
   * zero.
   */
  competitors?: readonly CompetitorInput[] | undefined;
  /**
   * Omitted means seed the five starter prompts for this brand and category.
   * Each prompt carries its own iterations, and a prompt without one gets the
   * default.
   */
  prompts?:
    | ReadonlyArray<{ text: string; tag: string | null; iterations?: number | undefined }>
    | undefined;
  /**
   * Custom perception prompt. Blank is refused. Omitted stores the default
   * template with its {brand} token, which is also the column default.
   */
  perceptionPrompt?: string | undefined;
  /** Omitted means auto-pick the cheapest extractor with a key configured. */
  extractionModelId?: string | null | undefined;
  monitoredModelIds: string[];
}

export interface CreateProjectOptions {
  /** Providers with a key in this process's environment, for the auto-pick. */
  providersWithKeys?: readonly string[] | undefined;
}

/**
 * The iterations a prompt is stored with. A prompt without a count gets the
 * default. A count outside the range is refused, not clamped, because a
 * clamped count would disagree with the spend estimate the wizard showed.
 */
function wizardIterations(value: number | undefined): number {
  if (value === undefined) return DEFAULT_WIZARD_ITERATIONS;
  if (!Number.isInteger(value) || value < MIN_WIZARD_ITERATIONS || value > MAX_WIZARD_ITERATIONS) {
    throw new InvalidInputError(
      "BAD_ITERATIONS",
      `repeats must be a whole number between ${MIN_WIZARD_ITERATIONS} and ${MAX_WIZARD_ITERATIONS}`,
    );
  }
  return value;
}

/**
 * Create a project and everything a run fans out over, in one transaction.
 *
 * Returns the new project id. Raises before writing anything when the brand has
 * no name (NO_BRAND) or no plausible domain (NO_DOMAIN, BAD_DOMAIN), when no
 * assistant was chosen (NO_MODELS), when a named model is not in the catalog
 * (MODEL_NOT_FOUND), when no prompt is left to ask (NO_PROMPTS), when a prompt
 * has no tag (TAG_REQUIRED) or an iteration count out of range
 * (BAD_ITERATIONS), when a perception prompt is given but blank
 * (NO_PERCEPTION_PROMPT), or when the brand description is over its cap
 * (DESCRIPTION_TOO_LONG).
 */
export function createProject(
  db: Driver,
  input: CreateProjectInput,
  options: CreateProjectOptions = {},
): { projectId: string } {
  const brandName = input.brandName.trim();
  if (brandName === "") {
    throw new InvalidInputError("NO_BRAND", "give the brand a name");
  }

  const domains = normalizeDomains(input.domains);
  if (domains.length === 0) {
    throw new InvalidInputError("NO_DOMAIN", "add at least one domain for the brand");
  }

  const models = resolveModels(db, input.monitoredModelIds);
  const extractionModelId = resolveExtractor(db, input, options.providersWithKeys ?? []);
  const prompts = (input.prompts ?? starterPrompts(brandName, input.category ?? ""))
    .map((prompt) => ({
      text: prompt.text.trim(),
      tag: normaliseTag(prompt.tag),
      iterations: wizardIterations(prompt.iterations),
    }))
    .filter((prompt) => prompt.text !== "");
  if (prompts.length === 0) {
    throw new InvalidInputError("NO_PROMPTS", "write at least one question to ask");
  }
  if (prompts.some((prompt) => prompt.tag === null)) {
    // Tags are how the Prompts tab and the statistics group questions, and
    // createPrompt refuses an untagged one. A new project must not start with
    // one either.
    throw new InvalidInputError("TAG_REQUIRED", "every question needs a tag");
  }

  if (input.perceptionPrompt !== undefined && !perceptionEnabled(input.perceptionPrompt)) {
    throw new InvalidInputError("NO_PERCEPTION_PROMPT", "write a perception prompt to ask");
  }
  const perception = input.perceptionPrompt?.trim();

  const description = normalizeDescription(input.description ?? "");
  if (description.length > DESCRIPTION_MAX_CHARS) {
    throw new InvalidInputError(
      "DESCRIPTION_TOO_LONG",
      `the brand description can be at most ${DESCRIPTION_MAX_CHARS} characters`,
    );
  }

  const competitors = normaliseCompetitors(input.competitors ?? [], brandName);
  const projectId = newId();
  const stamp = nowIso();

  db.transaction(() => {
    // Both prompts are bound instead of left to the column defaults, so one
    // statement covers both cases and a new project gets the texts in code.
    // Schema tests keep the column defaults equal to those constants.
    db.prepare(
      `INSERT INTO projects (id, name, extraction_model_id, perception_prompt, extraction_prompt, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      projectId,
      input.projectName?.trim() || brandName,
      extractionModelId,
      perception ?? PERCEPTION_TEMPLATE,
      EXTRACTION_SYSTEM,
      description === "" ? null : description,
      stamp,
      stamp,
    );

    insertBrand(db, {
      projectId,
      name: brandName,
      role: "target",
      variants: input.variants ?? [],
      domains,
      createdAt: stamp,
    });

    for (const competitor of competitors) {
      insertBrand(db, {
        projectId,
        name: competitor.name,
        role: "competitor",
        variants: [],
        domains: competitor.domains,
        createdAt: stamp,
      });
    }

    for (const prompt of prompts) {
      db.prepare(
        `INSERT INTO prompts (id, project_id, text, category, iterations, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(newId(), projectId, prompt.text, prompt.tag, prompt.iterations, stamp, stamp);
    }

    for (const modelId of models) {
      db.prepare("INSERT INTO project_models (project_id, model_id) VALUES (?, ?)").run(
        projectId,
        modelId,
      );
    }
  });

  return { projectId };
}

/**
 * createProject behind the setup check. Every model the project will call is
 * probed first: each selected assistant with web search forced, and the
 * extractor a create would resolve. Any failure refuses the create with
 * SETUP_CHECK_FAILED, whatever the browser claims. Under the mock provider
 * mode every probe answers "mocked", which passes, so the wizard works with no
 * keys.
 *
 * The real probes cost about a cent per OpenAI or Anthropic model, so code
 * that creates a project without spending calls createProject directly.
 */
export async function createProjectGated(
  db: Driver,
  input: CreateProjectInput,
  options: CreateProjectOptions = {},
  probe?: SetupProbe | undefined,
): Promise<{ projectId: string }> {
  const report = await checkSelection(
    db,
    {
      assistantModelIds: input.monitoredModelIds,
      extractorModelId: input.extractionModelId,
      providersWithKeys: options.providersWithKeys,
    },
    probe,
  );
  if (!allRowsPassed(report.rows)) {
    throw new InvalidInputError("SETUP_CHECK_FAILED", describeFailedRows(report.rows));
  }
  return createProject(db, input, options);
}

/** One sentence per failed model, with its fix hint, for the person creating. */
function describeFailedRows(rows: readonly SetupCheckRow[]): string {
  return rows
    .filter((row) => row.result.status !== "ok" && row.result.status !== "mocked")
    .map((row) =>
      row.result.hint
        ? `${row.displayName}: ${row.result.message} ${row.result.hint}`
        : `${row.displayName}: ${row.result.message}`,
    )
    .join(" · ");
}

export interface UpdateProjectInput {
  projectId: string;
  name?: string | undefined;
  extractionModelId?: string | null | undefined;
  perceptionPrompt?: string | undefined;
  /** Stored trimmed. Blank is refused. */
  extractionPrompt?: string | undefined;
}

/**
 * Change one or more project settings. A blank perception prompt is allowed and
 * is the off switch, so it is not treated as a missing value.
 *
 * There is no web search setting, because every answer searches.
 * projects.web_search_enabled is still in the schema, but nothing reads or
 * writes it.
 */
export function updateProject(db: Driver, input: UpdateProjectInput): { ok: true } {
  refuseDemoProject(db, input.projectId);
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name === "") throw new InvalidInputError("NO_NAME", "give the project a name");
    sets.push("name = ?");
    params.push(name);
  }
  if (input.extractionModelId !== undefined) {
    if (input.extractionModelId !== null) {
      const model = db
        .prepare("SELECT id FROM models WHERE id = ? AND is_extraction_model = 1 AND is_active = 1")
        .get<{ id: string }>(input.extractionModelId);
      if (!model) {
        throw new NotFoundError("MODEL_NOT_FOUND", "that extractor is not in the catalog");
      }
    }
    sets.push("extraction_model_id = ?");
    params.push(input.extractionModelId);
  }
  if (input.perceptionPrompt !== undefined) {
    sets.push("perception_prompt = ?");
    params.push(input.perceptionPrompt);
  }
  if (input.extractionPrompt !== undefined) {
    // Unlike perception there is no off switch. Every answer is scored, so a
    // project without an extraction prompt cannot run.
    const prompt = input.extractionPrompt.trim();
    if (prompt === "") {
      throw new InvalidInputError(
        "NO_EXTRACTION_PROMPT",
        "write the prompt that reads answers back into scores",
      );
    }
    sets.push("extraction_prompt = ?");
    params.push(prompt);
  }

  if (sets.length === 0) return { ok: true };

  params.push(input.projectId);
  const changes = db
    .prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`)
    .run(...params).changes;
  expectChanged(changes, "PROJECT_NOT_FOUND", "that project does not exist");
  return { ok: true };
}

/** Deleting a project takes its brands, prompts, runs and metrics with it. */
export function deleteProject(db: Driver, projectId: string): { ok: true } {
  const changes = db.prepare("DELETE FROM projects WHERE id = ?").run(projectId).changes;
  expectChanged(changes, "PROJECT_NOT_FOUND", "that project does not exist");
  return { ok: true };
}

function normaliseTag(tag: string | null): string | null {
  const trimmed = (tag ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/** Every domain validated and normalised, the bad ones named rather than dropped. */
export function normalizeDomains(domains: readonly string[]): string[] {
  const bad: string[] = [];
  const good: string[] = [];
  for (const raw of domains) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    if (!isPlausibleDomain(trimmed)) {
      bad.push(trimmed);
      continue;
    }
    const normalized = normalizeDomain(trimmed);
    if (!good.includes(normalized)) good.push(normalized);
  }
  if (bad.length > 0) {
    throw new InvalidInputError("BAD_DOMAIN", `these do not look like domains: ${bad.join(", ")}`);
  }
  return good;
}

/** A competitor as the create surface accepts one: a bare name, or a name with domains. */
export type CompetitorInput = string | { name: string; domains?: readonly string[] | undefined };

/**
 * Deduped against each other and the brand, domains validated and normalised.
 * A bad domain is refused and named with its competitor, as the brand's are.
 * A dropped domain would leave a citation rate stuck at zero that looks like
 * the assistant's fault.
 */
function normaliseCompetitors(
  competitors: readonly CompetitorInput[],
  brandName: string,
): Array<{ name: string; domains: string[] }> {
  const seen = new Set<string>([brandName.toLowerCase()]);
  const kept: Array<{ name: string; domains: string[] }> = [];
  for (const raw of competitors) {
    const entry = typeof raw === "string" ? { name: raw } : raw;
    const name = entry.name.trim();
    if (name === "" || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const bad = (entry.domains ?? [])
      .map((domain) => domain.trim())
      .filter((domain) => domain !== "" && !isPlausibleDomain(domain));
    if (bad.length > 0) {
      throw new InvalidInputError(
        "BAD_DOMAIN",
        `${name}: these do not look like domains: ${bad.join(", ")}`,
      );
    }
    kept.push({ name, domains: normalizeDomains(entry.domains ?? []) });
  }
  return kept;
}

function resolveModels(db: Driver, modelIds: readonly string[]): string[] {
  const unique = [...new Set(modelIds.filter((id) => id.trim() !== ""))];
  if (unique.length === 0) {
    throw new InvalidInputError("NO_MODELS", "choose at least one assistant to ask");
  }
  for (const modelId of unique) {
    const row = db
      .prepare("SELECT id FROM models WHERE id = ? AND is_active = 1")
      .get<{ id: string }>(modelId);
    if (!row) {
      throw new NotFoundError("MODEL_NOT_FOUND", `${modelId} is not in the catalog`);
    }
  }
  return unique;
}

/**
 * The extractor: the one the caller named, or the cheapest one whose provider
 * has a key. Null when the caller passed null or nothing qualifies.
 */
function resolveExtractor(
  db: Driver,
  input: CreateProjectInput,
  providersWithKeys: readonly string[],
): string | null {
  if (input.extractionModelId !== undefined && input.extractionModelId !== null) {
    const row = db
      .prepare("SELECT id FROM models WHERE id = ? AND is_extraction_model = 1 AND is_active = 1")
      .get<{ id: string }>(input.extractionModelId);
    if (!row) {
      throw new NotFoundError("MODEL_NOT_FOUND", "that extractor is not in the catalog");
    }
    return row.id;
  }
  if (input.extractionModelId === null) return null;
  const candidates = listExtractionModels(db);
  return pickExtractor(candidates, [...providersWithKeys])?.id ?? null;
}

interface InsertBrandInput {
  projectId: string;
  name: string;
  role: "target" | "competitor";
  variants: readonly string[];
  domains: readonly string[];
  createdAt: string;
}

function insertBrand(db: Driver, input: InsertBrandInput): void {
  db.prepare(
    `INSERT INTO brands (id, project_id, name, role, variants, domains, suggested_domains, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', ?)`,
  ).run(
    newId(),
    input.projectId,
    input.name,
    input.role,
    encodeList(input.variants),
    encodeList(input.domains),
    input.createdAt,
  );
}
