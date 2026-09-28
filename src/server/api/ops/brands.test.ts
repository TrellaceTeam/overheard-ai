import { afterEach, describe, expect, it } from "vitest";
import type { Driver } from "../../db/driver";
import { finalizeRun } from "../../logic/finalize-run";
import { freshDb, HAIKU, seedProject } from "../../logic/test-support";
import {
  createCompetitor,
  deleteBrand,
  getBrand,
  getTargetBrand,
  listBrands,
  listBrandsFull,
  recomputeCitations,
  setBrandRole,
  updateBrand,
} from "./brands";

let db: Driver;

afterEach(() => {
  db.close();
});

function open(): Driver {
  db = freshDb();
  seedProject(db);
  return db;
}

/** A done task with one observation, which is what a citation verdict hangs off. */
function seedObservation(
  db: Driver,
  options: { id: string; brandId: string | null; linkedUrl: string | null; isCited: 0 | 1 },
): void {
  const exists = db.prepare("SELECT 1 AS n FROM runs WHERE id = 'r1'").get<{ n: number }>();
  if (!exists) {
    db.prepare(
      `INSERT INTO runs (id, project_id, status, planned_calls, config_snapshot)
       VALUES ('r1', 'p1', 'completed', 2, '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO run_tasks (id, run_id, project_id, prompt_id, model_id, iteration, status, next_attempt_at, answer_text)
       VALUES ('t1', 'r1', 'p1', 'q1', ?, 1, 'done', '2026-01-01T00:00:00.000Z', 'an answer')`,
    ).run(HAIKU);
  }
  db.prepare(
    `INSERT INTO brand_observations
       (id, run_task_id, run_id, project_id, brand_id, raw_name, position, total_items,
        mention_type, linked_url, is_cited)
     VALUES (?, 't1', 'r1', 'p1', ?, 'Northwind Metrics', 1, 3, 'ranked', ?, ?)`,
  ).run(options.id, options.brandId, options.linkedUrl, options.isCited);
}

describe("listing", () => {
  it("puts the target first, then tracked, then discovered", () => {
    const db = open();
    createCompetitor(db, {
      projectId: "p1",
      name: "Northwind Metrics",
      domain: "northwind.example.com",
    });
    db.prepare(
      "INSERT INTO brands (id, project_id, name, role) VALUES ('b3', 'p1', 'Globex Search', 'discovered')",
    ).run();

    expect(listBrands(db, "p1").map((brand) => brand.role)).toEqual([
      "target",
      "competitor",
      "discovered",
    ]);
  });

  it("decodes the JSON list columns", () => {
    const db = open();
    const target = getTargetBrand(db, "p1");
    expect(target?.variants).toEqual([]);
    expect(target?.domains).toEqual([]);
    expect(listBrandsFull(db, "p1")[0]?.suggestedDomains).toEqual([]);
  });
});

describe("createCompetitor", () => {
  it("refuses a filled-in domain that does not look like one", () => {
    const db = open();
    expect(() =>
      createCompetitor(db, { projectId: "p1", name: "Northwind Metrics", domain: "northwind" }),
    ).toThrow(/BAD_DOMAIN/);
  });

  it("accepts no domain at all, the same rule project creation follows", () => {
    const db = open();
    const { id, existingRole } = createCompetitor(db, {
      projectId: "p1",
      name: "Northwind Metrics",
      domain: "",
    });
    expect(getBrand(db, id).domains).toEqual([]);
    expect(existingRole).toBeNull();
  });

  it("reports an already-tracked name and changes nothing, domains included", () => {
    const db = open();
    db.prepare(
      "INSERT INTO brands (id, project_id, name, role, domains) VALUES ('b5', 'p1', 'Northwind Metrics', 'competitor', '[\"northwind.example.com\"]')",
    ).run();

    const { id, existingRole } = createCompetitor(db, {
      projectId: "p1",
      name: "northwind metrics",
      domain: "something-else.example.com",
    });

    expect(id).toBe("b5");
    expect(existingRole).toBe("competitor");
    // The re-add changes nothing. A tracked brand's domains are edited on its
    // card.
    expect(getBrand(db, "b5").domains).toEqual(["northwind.example.com"]);
  });

  it("reports a discovered name it promoted", () => {
    const db = open();
    db.prepare(
      "INSERT INTO brands (id, project_id, name, role) VALUES ('b6', 'p1', 'Contoso Insights', 'discovered')",
    ).run();

    const { id, name, existingRole } = createCompetitor(db, {
      projectId: "p1",
      name: "contoso insights",
      domain: "contoso.example.com",
    });

    expect(id).toBe("b6");
    expect(existingRole).toBe("discovered");
    // The stored name comes back, so the route's message names the brand the
    // way its card does, however it was typed.
    expect(name).toBe("Contoso Insights");
    expect(getBrand(db, "b6").role).toBe("competitor");
  });

  it("re-scores past citations when a promotion brings a domain", () => {
    const db = open();
    db.prepare(
      "INSERT INTO brands (id, project_id, name, role) VALUES ('b6', 'p1', 'Contoso Insights', 'discovered')",
    ).run();
    // Discovered answers were scored against no domains, so the link was never
    // a citation. The arriving domain re-decides it.
    seedObservation(db, {
      id: "o2",
      brandId: "b6",
      linkedUrl: "https://contoso.example.com/product",
      isCited: 0,
    });

    const { existingRole, rescored } = createCompetitor(db, {
      projectId: "p1",
      name: "contoso insights",
      domain: "contoso.example.com",
    });

    expect(existingRole).toBe("discovered");
    expect(rescored).toEqual({ changed: 1, runs: 1 });
    const stored = db
      .prepare("SELECT is_cited FROM brand_observations WHERE id = 'o2'")
      .get<{ is_cited: number }>();
    expect(stored?.is_cited).toBe(1);
  });

  it("leaves citations alone when a promotion brings no domain", () => {
    const db = open();
    db.prepare(
      "INSERT INTO brands (id, project_id, name, role) VALUES ('b6', 'p1', 'Contoso Insights', 'discovered')",
    ).run();
    seedObservation(db, {
      id: "o3",
      brandId: "b6",
      linkedUrl: "https://contoso.example.com/product",
      isCited: 0,
    });

    const { existingRole, rescored } = createCompetitor(db, {
      projectId: "p1",
      name: "contoso insights",
      domain: "",
    });

    expect(existingRole).toBe("discovered");
    expect(rescored).toBeNull();
    const stored = db
      .prepare("SELECT is_cited FROM brand_observations WHERE id = 'o3'")
      .get<{ is_cited: number }>();
    expect(stored?.is_cited).toBe(0);
  });

  it("refuses the project's own brand as a competitor", () => {
    const db = open();
    // seedProject's target is "Acme Analytics". The promotion path must not
    // demote it.
    expect(() =>
      createCompetitor(db, {
        projectId: "p1",
        name: "acme analytics",
        domain: "",
      }),
    ).toThrow(/TARGET_BRAND/);
    expect(getBrand(db, "p1-brand").role).toBe("target");
  });

  it("stores the normalised domain", () => {
    const db = open();
    const { id } = createCompetitor(db, {
      projectId: "p1",
      name: "Northwind Metrics",
      domain: "HTTPS://WWW.Northwind.example.com/pricing",
    });
    expect(getBrand(db, id).domains).toEqual(["northwind.example.com"]);
  });

  it("promotes a brand the worker already discovered rather than duplicating it", () => {
    const db = open();
    db.prepare(
      "INSERT INTO brands (id, project_id, name, role) VALUES ('b9', 'p1', 'Contoso Insights', 'discovered')",
    ).run();

    const { id } = createCompetitor(db, {
      projectId: "p1",
      name: "contoso insights",
      domain: "contoso.example.com",
    });

    expect(id).toBe("b9");
    expect(getBrand(db, "b9").role).toBe("competitor");
    expect(listBrandsFull(db, "p1")).toHaveLength(2);
  });

  it("keeps the domains an already-discovered brand has when promoted without one", () => {
    const db = open();
    db.prepare(
      "INSERT INTO brands (id, project_id, name, role, domains) VALUES ('b8', 'p1', 'Contoso Insights', 'discovered', '[\"contoso.example.com\"]')",
    ).run();

    const { id } = createCompetitor(db, {
      projectId: "p1",
      name: "contoso insights",
      domain: "",
    });

    expect(id).toBe("b8");
    expect(getBrand(db, "b8").role).toBe("competitor");
    expect(getBrand(db, "b8").domains).toEqual(["contoso.example.com"]);
  });

  it("promotes it even when the name is not ASCII", () => {
    // SQLite's lower() folds only A-Z, so a lookup in SQL would not see that
    // these two are one company. The unique index would take the insert, and
    // the project would hold two rows for one brand, each scoring about half
    // the mentions.
    const db = open();
    db.prepare(
      "INSERT INTO brands (id, project_id, name, role) VALUES ('b7', 'p1', 'GRÜNER ANALYTICS', 'discovered')",
    ).run();

    const { id } = createCompetitor(db, {
      projectId: "p1",
      name: "Grüner Analytics",
      domain: "gruener.example.com",
    });

    expect(id).toBe("b7");
    expect(listBrandsFull(db, "p1")).toHaveLength(2);
  });
});

describe("updateBrand", () => {
  it("writes variants and domains as normalised JSON lists", () => {
    const db = open();
    const target = getTargetBrand(db, "p1");
    updateBrand(db, {
      id: target!.id,
      variants: [" Acme ", "Acme", "Acme Analytics Ltd"],
      domains: ["https://acme.example.com", "acme.example.com"],
    });

    const after = getBrand(db, target!.id);
    expect(after.variants).toEqual(["Acme", "Acme Analytics Ltd"]);
    expect(after.domains).toEqual(["acme.example.com"]);
  });

  it("names a bad domain instead of dropping it", () => {
    const db = open();
    const target = getTargetBrand(db, "p1");
    expect(() => updateBrand(db, { id: target!.id, domains: ["acme.example.com", "??"] })).toThrow(
      /BAD_DOMAIN/,
    );
  });

  it("refuses a brand that does not exist", () => {
    const db = open();
    expect(() => updateBrand(db, { id: "gone", name: "x" })).toThrow(/BRAND_NOT_FOUND/);
  });
});

describe("setBrandRole and deleteBrand", () => {
  it("tracks and untracks", () => {
    const db = open();
    db.prepare(
      "INSERT INTO brands (id, project_id, name, role) VALUES ('b3', 'p1', 'Globex Search', 'discovered')",
    ).run();

    setBrandRole(db, { id: "b3", role: "competitor" });
    expect(getBrand(db, "b3").role).toBe("competitor");

    setBrandRole(db, { id: "b3", role: "discovered" });
    expect(getBrand(db, "b3").role).toBe("discovered");
  });

  it("will not untrack or delete the brand the project is about", () => {
    const db = open();
    const target = getTargetBrand(db, "p1");
    expect(() => setBrandRole(db, { id: target!.id, role: "discovered" })).toThrow(/TARGET_BRAND/);
    expect(() => deleteBrand(db, target!.id)).toThrow(/TARGET_BRAND/);
  });

  it("deletes a competitor", () => {
    const db = open();
    const { id } = createCompetitor(db, {
      projectId: "p1",
      name: "Northwind Metrics",
      domain: "northwind.example.com",
    });
    deleteBrand(db, id);
    expect(listBrandsFull(db, "p1")).toHaveLength(1);
  });

  it("deletes two brands measured in the same scope, and leaves the rows a fresh score would", () => {
    const db = open();
    for (const [id, name] of [
      ["b2", "Northwind Metrics"],
      ["b3", "Globex Search"],
    ] as const) {
      db.prepare(
        "INSERT INTO brands (id, project_id, name, role) VALUES (?, 'p1', ?, 'competitor')",
      ).run(id, name);
    }
    seedObservation(db, { id: "o1", brandId: "b2", linkedUrl: null, isCited: 0 });
    seedObservation(db, { id: "o2", brandId: "b3", linkedUrl: null, isCited: 0 });
    seedObservation(db, { id: "o3", brandId: "p1-brand", linkedUrl: null, isCited: 0 });
    finalizeRun(db, "r1");

    deleteBrand(db, "b2");
    deleteBrand(db, "b3");

    const rows = () =>
      db
        .prepare(
          `SELECT model_id, prompt_id, brand_id, answers, mentions, share_of_voice FROM run_metrics
            WHERE run_id = 'r1' ORDER BY coalesce(model_id,''), coalesce(prompt_id,''), brand_id`,
        )
        .all();
    const afterDeletes = rows();
    expect(afterDeletes.every((row) => (row as { brand_id: string }).brand_id === "p1-brand")).toBe(
      true,
    );

    finalizeRun(db, "r1");
    expect(rows()).toEqual(afterDeletes);
  });
});

describe("recomputeCitations", () => {
  it("promotes a link that now matches a stored domain and recomputes the run", () => {
    const db = open();
    const { id } = createCompetitor(db, {
      projectId: "p1",
      name: "Northwind Metrics",
      domain: "wrong.example.com",
    });
    seedObservation(db, {
      id: "o1",
      brandId: id,
      linkedUrl: "https://northwind.example.com/product",
      isCited: 0,
    });

    updateBrand(db, { id, domains: ["northwind.example.com"] });
    const result = recomputeCitations(db, id);

    expect(result).toEqual({ changed: 1, runs: 1 });
    const stored = db
      .prepare("SELECT is_cited FROM brand_observations WHERE id = 'o1'")
      .get<{ is_cited: number }>();
    expect(stored?.is_cited).toBe(1);

    // Finalisation ran, so the run now has metric rows to show for it.
    const metrics = db
      .prepare("SELECT count(*) AS n FROM run_metrics WHERE run_id = 'r1'")
      .get<{ n: number }>();
    expect(metrics?.n ?? 0).toBeGreaterThan(0);
  });

  it("demotes a citation that no longer matches", () => {
    const db = open();
    const { id } = createCompetitor(db, {
      projectId: "p1",
      name: "Northwind Metrics",
      domain: "northwind.example.com",
    });
    seedObservation(db, {
      id: "o2",
      brandId: id,
      linkedUrl: "https://elsewhere.example.com/blog",
      isCited: 1,
    });

    expect(recomputeCitations(db, id)).toEqual({ changed: 1, runs: 1 });
  });

  it("changes nothing when every verdict already agrees", () => {
    const db = open();
    const { id } = createCompetitor(db, {
      projectId: "p1",
      name: "Northwind Metrics",
      domain: "northwind.example.com",
    });
    seedObservation(db, {
      id: "o3",
      brandId: id,
      linkedUrl: "https://northwind.example.com/x",
      isCited: 1,
    });

    expect(recomputeCitations(db, id)).toEqual({ changed: 0, runs: 0 });
  });

  it("refuses a brand that does not exist", () => {
    const db = open();
    expect(() => recomputeCitations(db, "gone")).toThrow(/BRAND_NOT_FOUND/);
  });
});
