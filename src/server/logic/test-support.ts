/**
 * The small amount of setup every colocated test in this folder needs: an
 * in-memory database with the schema and the model catalogue in it, and a
 * project with brands, prompts and monitored assistants.
 *
 * Imported only by *.test.ts files. Nothing at run time calls it, and no test
 * ever touches ./data.
 */
import { openDatabase, type Driver } from "../db/driver";
import { migrate } from "../db/migrate";
import { seedModels } from "../db/seed-models";

/** Two catalogue ids, so a test can name assistants without a lookup. */
export const HAIKU = "09fbf457-be35-4428-b72b-48bc04fcc01e";
export const SONNET = "8e4393f7-aaaf-415f-b52c-fec4b4166501";

export interface SeedPrompt {
  id: string;
  text: string;
  context?: string | null;
  iterations?: number;
  isActive?: boolean;
}

export interface SeedProject {
  id?: string;
  name?: string;
  brand?: string | null;
  perceptionPrompt?: string;
  extractionModelId?: string | null;
  prompts?: SeedPrompt[];
  models?: string[];
}

/** A migrated, seeded, empty database. The caller closes it. */
export function freshDb(): Driver {
  const db = openDatabase(":memory:");
  migrate(db);
  seedModels(db);
  return db;
}

/** Inserts a project and everything a run fans out over. Returns the project id. */
export function seedProject(db: Driver, options: SeedProject = {}): string {
  const projectId = options.id ?? "p1";
  const models = options.models ?? [HAIKU];

  db.prepare("INSERT INTO projects (id, name, extraction_model_id) VALUES (?, ?, ?)").run(
    projectId,
    options.name ?? "Acme Analytics",
    options.extractionModelId ?? HAIKU,
  );

  if (options.perceptionPrompt !== undefined) {
    db.prepare("UPDATE projects SET perception_prompt = ? WHERE id = ?").run(
      options.perceptionPrompt,
      projectId,
    );
  }

  if (options.brand !== null) {
    db.prepare(
      "INSERT INTO brands (id, project_id, name, role, created_at) VALUES (?, ?, ?, 'target', ?)",
    ).run(
      `${projectId}-brand`,
      projectId,
      options.brand ?? "Acme Analytics",
      "2026-01-01T00:00:00.000Z",
    );
  }

  const prompts = options.prompts ?? [{ id: "q1", text: "best analytics tools", iterations: 2 }];
  for (const prompt of prompts) {
    db.prepare(
      `INSERT INTO prompts (id, project_id, text, context, iterations, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      prompt.id,
      projectId,
      prompt.text,
      prompt.context ?? null,
      prompt.iterations ?? 1,
      prompt.isActive === false ? 0 : 1,
    );
  }

  for (const modelId of models) {
    db.prepare("INSERT INTO project_models (project_id, model_id) VALUES (?, ?)").run(
      projectId,
      modelId,
    );
  }

  return projectId;
}

/** Every env var the key reader tries, so a test can hold all of them. */
const PROVIDER_KEY_VARS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
] as const;

/**
 * Sets the named provider key vars to fake values and clears the rest. The
 * extraction resolution filters by key, so tests that buy prose or resolve a
 * model need keys present even though every call is injected or mocked.
 * Returns the restore function; call it in afterEach.
 */
export function setProviderKeys(...names: string[]): () => void {
  const saved = new Map<string, string | undefined>();
  for (const name of PROVIDER_KEY_VARS) {
    saved.set(name, process.env[name]);
    if (names.includes(name)) process.env[name] = "test-key-not-real";
    else delete process.env[name];
  }
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
