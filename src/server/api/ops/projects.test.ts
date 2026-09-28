import { afterEach, describe, expect, it } from "vitest";
import type { Driver } from "../../db/driver";
import { freshDb, HAIKU, SONNET } from "../../logic/test-support";
import { PERCEPTION_TEMPLATE } from "@/lib/perception";
import { EXTRACTION_SYSTEM } from "../../worker/extraction";
import type { SetupProbe } from "./setup-check";
import {
  createProject,
  createProjectGated,
  deleteProject,
  getProject,
  getProjectSettings,
  listProjects,
  mostRecentProjectId,
  updateProject,
} from "./projects";

const GPT_LUNA = "e473c6ad-df52-4ee6-bf96-f7913077f8d1";
const GEMINI_FLASH_LITE = "695e8bbd-b115-4c03-84b0-f91e20890a13";

let db: Driver;

afterEach(() => {
  db.close();
});

function open(): Driver {
  db = freshDb();
  return db;
}

function base() {
  return {
    brandName: "Acme Analytics",
    category: "analytics tools",
    domains: ["https://acme-analytics.example.com/pricing"],
    monitoredModelIds: [SONNET],
  };
}

describe("createProject", () => {
  it("writes the project, the target brand, the starter prompts and the assistants", () => {
    const db = open();
    const { projectId } = createProject(db, base(), { providersWithKeys: ["openai"] });

    const project = getProjectSettings(db, projectId);
    expect(project.name).toBe("Acme Analytics");

    const brands = db
      .prepare("SELECT name, role, domains FROM brands WHERE project_id = ?")
      .all<{ name: string; role: string; domains: string }>(projectId);
    expect(brands).toHaveLength(1);
    expect(brands[0]?.role).toBe("target");
    // The pricing page is stored as the bare host.
    expect(brands[0]?.domains).toBe(JSON.stringify(["acme-analytics.example.com"]));

    const prompts = db
      .prepare("SELECT text, category, iterations FROM prompts WHERE project_id = ?")
      .all<{ text: string; category: string | null; iterations: number }>(projectId);
    expect(prompts).toHaveLength(5);
    // The seeded starters carry the wizard default of three repeats, which the
    // wizard's spend estimate also assumes.
    expect(prompts.every((prompt) => prompt.iterations === 3)).toBe(true);
    expect(prompts.map((prompt) => prompt.category)).toContain("visibility");

    const models = db
      .prepare("SELECT model_id FROM project_models WHERE project_id = ?")
      .all<{ model_id: string }>(projectId);
    expect(models.map((row) => row.model_id)).toEqual([SONNET]);
  });

  it("stores the brand description as one sentence, and null when it is blank", () => {
    const db = open();
    const described = createProject(
      db,
      { ...base(), description: "  Web analytics for\nsmall shops in Leeds.  " },
      { providersWithKeys: ["openai"] },
    );
    const blank = createProject(
      db,
      { ...base(), brandName: "Northwind Metrics", description: " \n " },
      { providersWithKeys: ["openai"] },
    );
    const stored = (projectId: string) =>
      db
        .prepare("SELECT description FROM projects WHERE id = ?")
        .get<{ description: string | null }>(projectId)?.description;
    expect(stored(described.projectId)).toBe("Web analytics for small shops in Leeds.");
    expect(stored(blank.projectId)).toBeNull();
  });

  it("refuses a brand description over its cap, and writes nothing", () => {
    const db = open();
    expect(() =>
      createProject(db, { ...base(), description: "x".repeat(281) }, { providersWithKeys: [] }),
    ).toThrow(/DESCRIPTION_TOO_LONG/);
    expect(listProjects(db)).toHaveLength(0);
  });

  it("auto-picks the cheapest extractor whose provider has a key", () => {
    const db = open();
    const openai = createProject(db, base(), { providersWithKeys: ["openai"] });
    expect(getProjectSettings(db, openai.projectId).extractionModelId).toBe(GPT_LUNA);

    const google = createProject(
      db,
      { ...base(), brandName: "Northwind Metrics", domains: ["northwind.example.com"] },
      { providersWithKeys: ["google", "anthropic"] },
    );
    expect(getProjectSettings(db, google.projectId).extractionModelId).toBe(GEMINI_FLASH_LITE);
  });

  it("leaves the extractor unset when no provider has a key", () => {
    const db = open();
    const { projectId } = createProject(db, base(), { providersWithKeys: [] });
    expect(getProjectSettings(db, projectId).extractionModelId).toBeNull();
  });

  it("keeps the prompts the wizard was edited with", () => {
    const db = open();
    const { projectId } = createProject(db, {
      ...base(),
      prompts: [
        { text: "  Which analytics tool should a startup pick?  ", tag: "visibility" },
        { text: "   ", tag: null },
      ],
      // The blank one is dropped before the tag rule applies: an empty line
      // is not a question, tagged or not.
    });
    const prompts = db
      .prepare("SELECT text FROM prompts WHERE project_id = ?")
      .all<{ text: string }>(projectId);
    expect(prompts).toEqual([{ text: "Which analytics tool should a startup pick?" }]);
  });

  it("stores the repeats count each prompt arrived with", () => {
    const db = open();
    const { projectId } = createProject(db, {
      ...base(),
      prompts: [
        { text: "asked once", tag: "visibility", iterations: 1 },
        { text: "asked seven times", tag: "comparison", iterations: 7 },
      ],
    });
    const prompts = db
      .prepare("SELECT text, iterations FROM prompts WHERE project_id = ? ORDER BY rowid")
      .all<{ text: string; iterations: number }>(projectId);
    expect(prompts).toEqual([
      { text: "asked once", iterations: 1 },
      { text: "asked seven times", iterations: 7 },
    ]);
  });

  it("defaults a prompt with no repeats count to three", () => {
    const db = open();
    const { projectId } = createProject(db, {
      ...base(),
      prompts: [{ text: "legacy caller", tag: "visibility" }],
    });
    const prompt = db
      .prepare("SELECT iterations FROM prompts WHERE project_id = ?")
      .get<{ iterations: number }>(projectId);
    expect(prompt?.iterations).toBe(3);
  });

  it("refuses a repeats count outside one to twenty, and writes nothing", () => {
    const db = open();
    // Validation happens before the transaction opens, so every refusal
    // leaves the same empty database behind.
    for (const iterations of [0, 21, 2.5, -1]) {
      expect(() =>
        createProject(db, { ...base(), prompts: [{ text: "q", tag: "visibility", iterations }] }),
      ).toThrow(/BAD_ITERATIONS/);
    }
    expect(listProjects(db)).toHaveLength(0);
  });

  it("refuses a written question with no tag, and writes nothing", () => {
    const db = open();
    expect(() =>
      createProject(db, {
        ...base(),
        prompts: [
          { text: "tagged", tag: "visibility" },
          { text: "untagged", tag: null },
        ],
      }),
    ).toThrow(/TAG_REQUIRED/);
    expect(listProjects(db)).toHaveLength(0);
  });

  it("stores a competitor's domains with the competitor", () => {
    const db = open();
    const { projectId } = createProject(db, {
      ...base(),
      competitors: [
        { name: "Northwind Metrics", domains: ["https://Northwind.example.com/docs"] },
        { name: "Contoso Insights" },
        "Globex Search",
      ],
    });
    const rows = db
      .prepare(
        "SELECT name, domains FROM brands WHERE project_id = ? AND role = 'competitor' ORDER BY rowid",
      )
      .all<{ name: string; domains: string }>(projectId);
    expect(rows).toEqual([
      { name: "Northwind Metrics", domains: JSON.stringify(["northwind.example.com"]) },
      { name: "Contoso Insights", domains: "[]" },
      { name: "Globex Search", domains: "[]" },
    ]);
  });

  it("names the competitor whose domain is not a domain, and writes nothing", () => {
    const db = open();
    expect(() =>
      createProject(db, {
        ...base(),
        competitors: [{ name: "Northwind Metrics", domains: ["not a domain"] }],
      }),
    ).toThrow(/BAD_DOMAIN.*Northwind Metrics.*not a domain/s);
    expect(listProjects(db)).toHaveLength(0);
  });

  it("adds competitors as tracked brands and drops a repeat of the target", () => {
    const db = open();
    const { projectId } = createProject(db, {
      ...base(),
      competitors: ["Northwind Metrics", "northwind metrics", "Acme Analytics", "  "],
    });
    const competitors = db
      .prepare("SELECT name FROM brands WHERE project_id = ? AND role = 'competitor'")
      .all<{ name: string }>(projectId);
    expect(competitors).toEqual([{ name: "Northwind Metrics" }]);
  });

  it("names the domains that are not domains", () => {
    const db = open();
    expect(() => createProject(db, { ...base(), domains: ["acme.", "not a domain"] })).toThrow(
      /BAD_DOMAIN.*acme\./s,
    );
  });

  it("refuses a project with no assistant and writes nothing", () => {
    const db = open();
    expect(() => createProject(db, { ...base(), monitoredModelIds: [] })).toThrow(/NO_MODELS/);
    expect(listProjects(db)).toHaveLength(0);
  });

  it("refuses a model that is not in the catalog and writes nothing", () => {
    const db = open();
    expect(() => createProject(db, { ...base(), monitoredModelIds: ["not-a-model"] })).toThrow(
      /MODEL_NOT_FOUND/,
    );
    expect(listProjects(db)).toHaveLength(0);
  });

  it("stores a custom perception prompt when provided", () => {
    const db = open();
    const custom = "What do AI models think of {brand} in enterprise?";
    const { projectId } = createProject(db, { ...base(), perceptionPrompt: custom });
    expect(getProjectSettings(db, projectId).perceptionPrompt).toBe(custom);
  });

  it("rejects a blank perception prompt when provided, and writes nothing", () => {
    const db = open();
    expect(() => createProject(db, { ...base(), perceptionPrompt: "   " })).toThrow(
      /NO_PERCEPTION_PROMPT/,
    );
    expect(listProjects(db)).toHaveLength(0);
  });
});

describe("reads", () => {
  it("lists projects oldest first and finds the most recent", () => {
    const db = open();
    const first = createProject(db, base()).projectId;
    const second = createProject(db, {
      ...base(),
      brandName: "Contoso Insights",
      domains: ["contoso.example.com"],
    }).projectId;

    expect(listProjects(db).map((project) => project.id)).toEqual([first, second]);
    expect(mostRecentProjectId(db)).toBe(second);
  });

  it("raises a named error for a project that does not exist", () => {
    const db = open();
    expect(() => getProject(db, "nope")).toThrow(/PROJECT_NOT_FOUND/);
    expect(() => getProjectSettings(db, "nope")).toThrow(/PROJECT_NOT_FOUND/);
    expect(() => getProjectSettings(db, "nope")).toThrow(/PROJECT_NOT_FOUND/);
  });

  it("serves the canonical perception prompt, token intact, when none was given", () => {
    const db = open();
    const { projectId } = createProject(db, base());
    expect(getProjectSettings(db, projectId).perceptionPrompt).toBe(PERCEPTION_TEMPLATE);
    expect(getProjectSettings(db, projectId).extractionPrompt).toBe(EXTRACTION_SYSTEM);
  });
});

describe("updateProject", () => {
  it("changes the settings the screen owns", () => {
    const db = open();
    const { projectId } = createProject(db, base());

    updateProject(db, {
      projectId,
      perceptionPrompt: "What do you know about {brand}?",
      extractionModelId: HAIKU,
      name: "Acme",
    });

    const settings = getProjectSettings(db, projectId);
    expect(settings).toMatchObject({
      name: "Acme",
      extractionModelId: HAIKU,
      perceptionPrompt: "What do you know about {brand}?",
    });
    expect(settings).not.toHaveProperty("webSearchEnabled");
  });

  it("stores a custom extraction prompt, trimmed, and reports the default beside it", () => {
    const db = open();
    const { projectId } = createProject(db, base());

    updateProject(db, { projectId, extractionPrompt: "  Count every brand named.  " });

    const settings = getProjectSettings(db, projectId);
    expect(settings.extractionPrompt).toBe("Count every brand named.");
    expect(settings.extractionPromptDefault).toBe(EXTRACTION_SYSTEM);
  });

  it("round-trips a reset: storing the reported default restores the canonical prompt", () => {
    const db = open();
    const { projectId } = createProject(db, base());
    updateProject(db, { projectId, extractionPrompt: "Count every brand named." });

    const { extractionPromptDefault } = getProjectSettings(db, projectId);
    updateProject(db, { projectId, extractionPrompt: extractionPromptDefault });

    expect(getProjectSettings(db, projectId).extractionPrompt).toBe(EXTRACTION_SYSTEM);
  });

  it("refuses a blank extraction prompt, because extraction has no off switch", () => {
    const db = open();
    const { projectId } = createProject(db, base());
    expect(() => updateProject(db, { projectId, extractionPrompt: "   " })).toThrow(
      "NO_EXTRACTION_PROMPT",
    );
    expect(getProjectSettings(db, projectId).extractionPrompt).toBe(EXTRACTION_SYSTEM);
  });

  it("accepts a blank perception prompt, which is the off switch", () => {
    const db = open();
    const { projectId } = createProject(db, base());
    updateProject(db, { projectId, perceptionPrompt: "" });
    expect(getProjectSettings(db, projectId).perceptionPrompt).toBe("");
  });

  it("refuses an extractor that cannot extract", () => {
    const db = open();
    const { projectId } = createProject(db, base());
    expect(() => updateProject(db, { projectId, extractionModelId: SONNET })).toThrow(
      /MODEL_NOT_FOUND/,
    );
  });

  it("treats a stale project id as a failure, not a silent success", () => {
    const db = open();
    expect(() => updateProject(db, { projectId: "gone", name: "x" })).toThrow(/PROJECT_NOT_FOUND/);
    expect(() => deleteProject(db, "gone")).toThrow(/PROJECT_NOT_FOUND/);
  });
});

describe("deleteProject", () => {
  it("takes the brands and prompts with it", () => {
    const db = open();
    const { projectId } = createProject(db, base());
    deleteProject(db, projectId);

    expect(listProjects(db)).toHaveLength(0);
    const brands = db
      .prepare("SELECT count(*) AS n FROM brands WHERE project_id = ?")
      .get<{ n: number }>(projectId);
    expect(brands?.n).toBe(0);
  });
});

describe("createProjectGated", () => {
  const passing: SetupProbe = async () => ({ status: "ok", message: "works" });

  it("creates the project when every probe passes", async () => {
    open();
    const { projectId } = await createProjectGated(
      db,
      base(),
      { providersWithKeys: ["openai"] },
      passing,
    );
    expect(db.prepare("SELECT COUNT(*) c FROM projects").get<{ c: number }>()?.c).toBe(1);
    expect(projectId.length).toBeGreaterThan(0);
  });

  it("refuses when a probe fails, names the model and the fix, and creates nothing", async () => {
    open();
    const failing: SetupProbe = async (kind, provider) =>
      kind === "assistant" && provider === "anthropic"
        ? {
            status: "no_credits",
            message: "The key works, but the account's credit balance is too low.",
            hint: "Add credit at console.anthropic.com/settings/plans.",
          }
        : { status: "ok", message: "works" };

    const error = await createProjectGated(db, base(), { providersWithKeys: ["openai"] }, failing)
      .then(() => null)
      .catch((thrown: unknown) => thrown as Error);
    expect(error?.message).toMatch(/SETUP_CHECK_FAILED/);
    expect(error?.message).toMatch(
      /Claude Sonnet 5[\s\S]*credit balance is too low[\s\S]*console\.anthropic\.com/,
    );
    expect(db.prepare("SELECT COUNT(*) c FROM projects").get<{ c: number }>()?.c).toBe(0);
  });

  it("probes the extractor that createProject will resolve, not a stand-in", async () => {
    open();
    const seen: Array<[string, string]> = [];
    const probe: SetupProbe = async (kind, _provider, modelId) => {
      seen.push([kind, modelId]);
      return { status: "ok", message: "works" };
    };
    await createProjectGated(db, base(), { providersWithKeys: ["openai"] }, probe);
    expect(seen).toEqual([
      ["assistant", "claude-sonnet-5"],
      ["extractor", "gpt-5.6-luna"],
    ]);
  });

  it("passes in mock mode without a probe: every check comes back mocked", async () => {
    open();
    process.env["OVERHEARD_MOCK_PROVIDERS"] = "1";
    try {
      const { projectId } = await createProjectGated(db, base(), { providersWithKeys: [] });
      expect(projectId.length).toBeGreaterThan(0);
    } finally {
      delete process.env["OVERHEARD_MOCK_PROVIDERS"];
    }
  });
});
