import { describe, expect, it } from "vitest";
import {
  buildObservations,
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_SHAPE,
  extractionUserPrompt,
  parseExtraction,
  resolveBrand,
  toGeminiResponseSchema,
  type BrandResolver,
  type JsonSchema,
  type MatchableBrand,
} from "./extraction";

// Every brand here is fictional. Acme Analytics is the target, the rest are
// rivals, and every domain is under example.com.

const TARGET: MatchableBrand = {
  id: "brand-acme",
  name: "Acme Analytics",
  variants: ["Acme"],
  domains: ["acme-analytics.example.com"],
};

const RIVAL: MatchableBrand = {
  id: "brand-northwind",
  name: "Northwind Metrics",
  variants: [],
  domains: ["northwind.example.com"],
};

const PROJECT_BRANDS: MatchableBrand[] = [TARGET, RIVAL];

/** A resolver over a fixed list that records what it was asked to create. */
function fakeResolver(
  brands: MatchableBrand[],
  create: (name: string) => string | null = () => null,
): BrandResolver & { created: string[] } {
  const created: string[] = [];
  return {
    created,
    list: () => brands,
    create: (name: string) => {
      created.push(name);
      const id = create(name);
      if (id) brands.push({ id, name, variants: [], domains: [] });
      return id;
    },
    invalidate: () => {},
  };
}

describe("parseExtraction", () => {
  it("reads a ranked list with positions and a total", () => {
    const parsed = parseExtraction(
      JSON.stringify({
        answer_format: "ranked_list",
        total_items: 2,
        brands: [
          {
            name: "Acme Analytics",
            position: 1,
            mention_type: "ranked",
            linked_url: "https://acme-analytics.example.com",
            evidence: "Acme Analytics leads on coverage.",
          },
          {
            name: "Northwind Metrics",
            position: 2,
            mention_type: "ranked",
            evidence: "Runner-up.",
          },
        ],
      }),
    );
    expect(parsed.answer_format).toBe("ranked_list");
    expect(parsed.total_items).toBe(2);
    expect(parsed.brands.map((b) => b.position)).toEqual([1, 2]);
    expect(parsed.brands[0]?.linked_url).toBe("https://acme-analytics.example.com");
    expect(parsed.brands[1]?.linked_url).toBeNull();
  });

  it("reads an unranked list, where every position is null", () => {
    const parsed = parseExtraction(
      JSON.stringify({
        answer_format: "unranked_list",
        total_items: 2,
        brands: [
          { name: "Acme Analytics", position: null, mention_type: "mentioned" },
          { name: "Contoso Insights", mention_type: "recommended" },
        ],
      }),
    );
    expect(parsed.answer_format).toBe("unranked_list");
    expect(parsed.brands.every((b) => b.position === null)).toBe(true);
    expect(parsed.brands[1]?.mention_type).toBe("recommended");
  });

  it("reads prose, where the count comes from the brands it found", () => {
    const parsed = parseExtraction(
      JSON.stringify({
        answer_format: "prose",
        brands: [{ name: "Fabrikam Labs", mention_type: "negative", evidence: "Hard to set up." }],
      }),
    );
    expect(parsed.answer_format).toBe("prose");
    expect(parsed.total_items).toBe(1);
    expect(parsed.brands[0]?.mention_type).toBe("negative");
  });

  it("reads a refusal as an empty brand list", () => {
    const parsed = parseExtraction(
      JSON.stringify({ answer_format: "refusal", total_items: null, brands: [] }),
    );
    expect(parsed.answer_format).toBe("refusal");
    expect(parsed.brands).toEqual([]);
    expect(parsed.total_items).toBeNull();
  });

  it("survives a fenced code block and commentary either side", () => {
    const body = JSON.stringify({ answer_format: "prose", brands: [] });
    expect(parseExtraction(`\`\`\`json\n${body}\n\`\`\``).answer_format).toBe("prose");
    expect(parseExtraction(`Here you go:\n${body}\nHope that helps!`).answer_format).toBe("prose");
  });

  it("throws on a missing object or an unknown format, so the caller retries once", () => {
    expect(() => parseExtraction("no json here")).toThrow(/SCHEMA_VIOLATION: no JSON object/);
    expect(() => parseExtraction(JSON.stringify({ answer_format: "essay", brands: [] }))).toThrow(
      /SCHEMA_VIOLATION: answer_format/,
    );
  });

  it("skips a nameless entry rather than storing a blank brand", () => {
    const parsed = parseExtraction(
      JSON.stringify({
        answer_format: "prose",
        brands: [{ name: "  " }, { position: 1 }, { name: "Globex Search" }],
      }),
    );
    expect(parsed.brands.map((b) => b.name)).toEqual(["Globex Search"]);
  });

  it("normalises the loose fields a model gets wrong", () => {
    const parsed = parseExtraction(
      JSON.stringify({
        answer_format: "prose",
        total_items: 1.6,
        brands: [
          {
            name: "Globex Search",
            position: 0,
            mention_type: "endorsed",
            linked_url: "globex.example.com",
            evidence: "e".repeat(400),
          },
        ],
      }),
    );
    const brand = parsed.brands[0];
    expect(parsed.total_items).toBe(2);
    expect(brand?.position).toBeNull();
    // An unknown type falls back rather than failing the whole answer.
    expect(brand?.mention_type).toBe("mentioned");
    // A bare host is not a URL.
    expect(brand?.linked_url).toBeNull();
    expect(brand?.evidence).toHaveLength(200);
  });
});

describe("extractionUserPrompt", () => {
  it("caps a pathological answer rather than sending it whole", () => {
    expect(extractionUserPrompt("x".repeat(50_000)).length).toBeLessThan(35_000);
  });
});

describe("resolveBrand", () => {
  const extracted = (patch: Record<string, unknown> = {}) =>
    ({
      name: "Acme Analytics",
      position: null,
      mention_type: "mentioned" as const,
      linked_url: null,
      evidence: null,
      ...patch,
    }) as Parameters<typeof resolveBrand>[0];

  it("matches an exact name, case insensitively", () => {
    expect(resolveBrand(extracted({ name: "acme analytics" }), PROJECT_BRANDS).brandId).toBe(
      "brand-acme",
    );
  });

  it("matches a stored variant", () => {
    expect(resolveBrand(extracted({ name: "Acme" }), PROJECT_BRANDS).brandId).toBe("brand-acme");
  });

  it("matches on the normalised name, so a legal suffix does not split a brand", () => {
    expect(resolveBrand(extracted({ name: "Acme Analytics Inc." }), PROJECT_BRANDS).brandId).toBe(
      "brand-acme",
    );
  });

  it("matches on the link host when the name does not match", () => {
    const res = resolveBrand(
      extracted({ name: "Their tooling", linked_url: "https://docs.northwind.example.com/x" }),
      PROJECT_BRANDS,
    );
    expect(res.brandId).toBe("brand-northwind");
    expect(res.isCited).toBe(true);
  });

  it("does not let a name of pure punctuation claim a brand", () => {
    expect(resolveBrand(extracted({ name: "---" }), PROJECT_BRANDS).brandId).toBeNull();
  });

  it("is not a citation when the link belongs to someone else", () => {
    const res = resolveBrand(
      extracted({ linked_url: "https://review-site.example.com/best-tools" }),
      PROJECT_BRANDS,
    );
    expect(res.brandId).toBe("brand-acme");
    expect(res.isCited).toBe(false);
  });
});

describe("buildObservations", () => {
  it("carries position, total and mention type onto every row", () => {
    const extraction = parseExtraction(
      JSON.stringify({
        answer_format: "ranked_list",
        total_items: 2,
        brands: [
          { name: "Acme Analytics", position: 1, mention_type: "ranked", evidence: "First." },
          { name: "Northwind Metrics", position: 2, mention_type: "ranked", evidence: "Second." },
        ],
      }),
    );
    const rows = buildObservations(extraction, fakeResolver([...PROJECT_BRANDS]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      brandId: "brand-acme",
      rawName: "Acme Analytics",
      position: 1,
      totalItems: 2,
      mentionType: "ranked",
      isCited: false,
    });
    expect(rows[1]?.brandId).toBe("brand-northwind");
  });

  it("writes no rows for a refusal", () => {
    const extraction = parseExtraction(
      JSON.stringify({ answer_format: "refusal", brands: [], total_items: null }),
    );
    expect(buildObservations(extraction, fakeResolver([...PROJECT_BRANDS]))).toEqual([]);
  });

  it("marks the target brand's own link as a citation", () => {
    // The answer links the brand's own site, and the link host matches a
    // stored domain, so this is a citation, not a bare mention.
    const extraction = parseExtraction(
      JSON.stringify({
        answer_format: "prose",
        brands: [
          {
            name: "Acme Analytics",
            mention_type: "recommended",
            linked_url: "https://acme-analytics.example.com/pricing",
            evidence: "See their pricing page.",
          },
        ],
      }),
    );
    const rows = buildObservations(extraction, fakeResolver([...PROJECT_BRANDS]));
    expect(rows[0]).toMatchObject({
      brandId: "brand-acme",
      isCited: true,
      linkedUrl: "https://acme-analytics.example.com/pricing",
    });
  });

  it("creates a discovered brand and re-decides its citation against the new row", () => {
    // resolveBrand said "not cited" only because it matched no brand. A brand
    // created here has no domains, so an attributed link is its citation.
    const extraction = parseExtraction(
      JSON.stringify({
        answer_format: "prose",
        brands: [
          {
            name: "Contoso Insights",
            mention_type: "mentioned",
            linked_url: "https://contoso.example.com",
          },
        ],
      }),
    );
    const resolver = fakeResolver([...PROJECT_BRANDS], () => "brand-contoso");
    const rows = buildObservations(extraction, resolver);
    expect(resolver.created).toEqual(["Contoso Insights"]);
    expect(rows[0]).toMatchObject({ brandId: "brand-contoso", isCited: true });
  });

  it("keeps the row with a null brand id when the name resolves to nothing", () => {
    // The insert lost a race and the re-read still found nothing. The row is
    // kept and excluded from metrics rather than dropped, so the answer's own
    // record stays complete.
    const extraction = parseExtraction(
      JSON.stringify({
        answer_format: "prose",
        brands: [{ name: "Fabrikam Labs", mention_type: "mentioned" }],
      }),
    );
    const rows = buildObservations(extraction, fakeResolver([...PROJECT_BRANDS]));
    expect(rows[0]).toMatchObject({ brandId: null, rawName: "Fabrikam Labs", isCited: false });
  });

  it("keeps both rows when one answer names a brand twice", () => {
    // finalizeRun groups by (task, brand), so one answer counts at most one
    // mention per brand. Collapsing here would lose the second piece of
    // evidence.
    const extraction = parseExtraction(
      JSON.stringify({
        answer_format: "prose",
        total_items: 1,
        brands: [
          { name: "Acme Analytics", mention_type: "recommended", evidence: "Good breadth." },
          { name: "Acme", mention_type: "mentioned", evidence: "Also cheap." },
        ],
      }),
    );
    const rows = buildObservations(extraction, fakeResolver([...PROJECT_BRANDS]));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.brandId)).toEqual(["brand-acme", "brand-acme"]);
  });
});

/** The two navigations every schema assertion makes, named once. */
function props(schema: JsonSchema): Record<string, JsonSchema> {
  return schema["properties"] as Record<string, JsonSchema>;
}
function items(schema: JsonSchema): JsonSchema {
  return schema["items"] as JsonSchema;
}

describe("the enforced extraction shape", () => {
  it("carries the same enums the parser accepts, so enforcement and reading cannot drift", () => {
    const properties = props(EXTRACTION_JSON_SCHEMA);
    expect(properties["answer_format"]).toMatchObject({
      type: "string",
      enum: ["ranked_list", "unranked_list", "prose", "refusal"],
    });
    expect(props(items(properties["brands"]!))["mention_type"]).toMatchObject({
      type: "string",
      enum: ["ranked", "recommended", "mentioned", "negative"],
    });
  });

  it("is strict-ready: every property required and nothing additional allowed, at both levels", () => {
    // OpenAI's strict mode refuses a schema where a property is optional or an
    // object is open.
    const properties = props(EXTRACTION_JSON_SCHEMA);
    expect(EXTRACTION_JSON_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: Object.keys(properties),
    });
    const item = items(properties["brands"]!);
    expect(item).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: Object.keys(props(item)),
    });
  });

  it("describes an instance parseExtraction accepts, minimally and fully", () => {
    const minimal = { answer_format: "refusal", total_items: null, brands: [] };
    expect(parseExtraction(JSON.stringify(minimal)).answer_format).toBe("refusal");

    const full = {
      answer_format: "ranked_list",
      total_items: 1,
      brands: [
        {
          name: "Acme Analytics",
          position: 1,
          mention_type: "ranked",
          linked_url: "https://acme-analytics.example.com",
          evidence: "Acme Analytics is a reasonable choice.",
        },
      ],
    };
    const parsed = parseExtraction(JSON.stringify(full));
    expect(parsed.brands[0]).toMatchObject({ name: "Acme Analytics", position: 1 });
  });

  it("names the shape, which is what the provider requests reference", () => {
    expect(EXTRACTION_SHAPE).toEqual({
      name: "brand_extraction",
      schema: EXTRACTION_JSON_SCHEMA,
    });
  });
});

describe("toGeminiResponseSchema", () => {
  const gemini = toGeminiResponseSchema(EXTRACTION_JSON_SCHEMA);

  it("speaks Gemini's dialect: uppercase types, required kept", () => {
    expect(gemini["type"]).toBe("OBJECT");
    expect(gemini["required"]).toEqual(["answer_format", "total_items", "brands"]);
  });

  it("turns a null union into the nullable keyword beside one type", () => {
    const properties = props(gemini);
    expect(properties["total_items"]).toEqual({ type: "INTEGER", nullable: true });
    const itemProps = props(items(properties["brands"]!));
    expect(itemProps["linked_url"]).toEqual({ type: "STRING", nullable: true });
    expect(itemProps["evidence"]).toEqual({ type: "STRING", nullable: true });
    expect(itemProps["position"]).toEqual({ type: "INTEGER", nullable: true });
  });

  it("keeps plain types plain and enums intact", () => {
    const properties = props(gemini);
    expect(properties["answer_format"]).toEqual({
      type: "STRING",
      enum: ["ranked_list", "unranked_list", "prose", "refusal"],
    });
    const itemProps = props(items(properties["brands"]!));
    expect(itemProps["name"]).toEqual({ type: "STRING" });
    expect(itemProps["mention_type"]).toMatchObject({ type: "STRING" });
  });

  it("translates arrays recursively and drops additionalProperties, which Gemini does not take", () => {
    const properties = props(gemini);
    expect(properties["brands"]).toMatchObject({ type: "ARRAY" });
    expect(items(properties["brands"]!)["type"]).toBe("OBJECT");
    const serialized = JSON.stringify(gemini);
    expect(serialized).not.toContain("additionalProperties");
  });

  it("refuses a type it cannot express rather than sending Gemini a guess", () => {
    expect(() => toGeminiResponseSchema({ type: "banana" })).toThrow(/GEMINI_SCHEMA/);
  });
});
