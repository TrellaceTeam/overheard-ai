// The extraction contract: a second, cheap model call that turns a raw answer
// into structured brand observations.
//
// Name normalisation and domain matching live in @/lib/brand-matching, which
// has no server imports, because the dashboard needs the same definitions on
// the client. They are re-exported here so this file shows the whole rule set.
//
// This module owns the shape of the rows, not the writing of them. It returns
// ObservationInput[], and storeExtraction in src/server/logic writes them.
import { hostMatchesDomain, isCitation, linkHost, normalizeName } from "@/lib/brand-matching";
import type { ObservationInput } from "../logic/types";

export { hostMatchesDomain, isCitation, linkHost, normalizeName };

export const EXTRACTION_SYSTEM = `You extract brand mentions from an AI assistant's answer. Return only JSON matching
the schema. Do not add commentary.

Schema:
{"answer_format":"ranked_list|unranked_list|prose|refusal","total_items":number|null,
 "brands":[{"name":string,"position":number|null,
 "mention_type":"ranked|recommended|mentioned|negative","linked_url":string|null,"evidence":string}]}

Rules:
1. List every company, product, or brand named as an option, including ones the
   answer discourages. Do not list generic categories.
2. Set position only when the answer presents an ordered preference (numbered list,
   or explicit ranking language such as "best", "second", "runner-up"). A bulleted
   list with no ordering has null positions and answer_format "unranked_list".
3. total_items is the number of distinct brands presented as options.
4. linked_url must be a URL that appears verbatim in the answer and is attributed to
   that brand. If a URL appears but belongs to a review site, a comparison article,
   or another brand, do not attach it. Use null when unsure.
5. evidence must be copied verbatim from the answer, at most 200 characters.
6. If the answer declines to recommend anything, use answer_format "refusal" with an
   empty brands array.`;

/**
 * The slice is a backstop for a provider that ignores max_tokens, so
 * extraction stays a cheap call. It sits above what ANSWER_MAX_TOKENS allows,
 * because cutting a real answer short would lose every brand named after the
 * cut.
 */
export function extractionUserPrompt(answerText: string): string {
  return `Answer to extract from:\n---\n${answerText.slice(0, 34_000)}\n---`;
}

export type ExtractedBrand = {
  name: string;
  position: number | null;
  mention_type: "ranked" | "recommended" | "mentioned" | "negative";
  linked_url: string | null;
  evidence: string | null;
};

export type Extraction = {
  answer_format: "ranked_list" | "unranked_list" | "prose" | "refusal";
  total_items: number | null;
  brands: ExtractedBrand[];
};

const FORMATS = ["ranked_list", "unranked_list", "prose", "refusal"] as const;
const TYPES = ["ranked", "recommended", "mentioned", "negative"] as const;

export type JsonSchema = Record<string, unknown>;

/** The shape plus the name each provider's enforcement needs to give it. */
export interface EnforcedShape {
  name: string;
  schema: JsonSchema;
  /** What Anthropic's forced tool is told it is for. Omitted, it says extraction. */
  description?: string | undefined;
}

export const EXTRACTION_SCHEMA_NAME = "brand_extraction";

/**
 * The extraction shape, sent in the request. EXTRACTION_SYSTEM asks for it in
 * words, but a JSON mode only guarantees valid JSON of some shape. Each
 * provider enforces this schema its own way: OpenAI strict structured outputs,
 * a Gemini response schema, an Anthropic forced tool whose input schema is
 * this. The prompt still describes it as a second line of defence.
 *
 * Written in the dialect all three accept: every property required,
 * additionalProperties false, and nullability as a type union, not a keyword.
 * toGeminiResponseSchema translates what Gemini spells differently.
 */
export const EXTRACTION_JSON_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer_format", "total_items", "brands"],
  properties: {
    answer_format: { type: "string", enum: [...FORMATS] },
    total_items: { type: ["integer", "null"] },
    brands: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "position", "mention_type", "linked_url", "evidence"],
        properties: {
          name: { type: "string" },
          position: { type: ["integer", "null"] },
          mention_type: { type: "string", enum: [...TYPES] },
          linked_url: { type: ["string", "null"] },
          // Nullable because a brand named in passing may have no sentence to
          // point at, and a required string would make the model invent one.
          evidence: { type: ["string", "null"] },
        },
      },
    },
  },
};

/** Sent by every enforced extraction call and by the setup probe. */
export const EXTRACTION_SHAPE: EnforcedShape = {
  name: EXTRACTION_SCHEMA_NAME,
  schema: EXTRACTION_JSON_SCHEMA,
};

const GEMINI_TYPES: Record<string, string> = {
  object: "OBJECT",
  array: "ARRAY",
  string: "STRING",
  integer: "INTEGER",
  number: "NUMBER",
  boolean: "BOOLEAN",
};

/**
 * The canonical schema in Gemini's dialect: uppercase type names, nullability
 * as `nullable: true` beside a single type instead of a union, and no
 * additionalProperties, which its OpenAPI subset does not accept. Translated
 * from the canonical object so the two cannot drift.
 */
export function toGeminiResponseSchema(schema: JsonSchema): JsonSchema {
  const rawType = schema["type"];
  const parts = Array.isArray(rawType) ? rawType.map(String) : [String(rawType ?? "")];
  const nullable = parts.includes("null");
  const primary = parts.find((part) => part !== "null");
  const geminiType = primary ? GEMINI_TYPES[primary] : undefined;
  if (!geminiType) {
    throw new Error(`GEMINI_SCHEMA: unsupported type ${JSON.stringify(rawType)}`);
  }

  const out: JsonSchema = { type: geminiType };
  if (nullable) out["nullable"] = true;
  if (Array.isArray(schema["enum"])) out["enum"] = schema["enum"];

  if (primary === "object") {
    const properties = schema["properties"];
    if (properties && typeof properties === "object") {
      const converted: Record<string, JsonSchema> = {};
      for (const [key, value] of Object.entries(properties as Record<string, JsonSchema>)) {
        converted[key] = toGeminiResponseSchema(value);
      }
      out["properties"] = converted;
    }
    if (Array.isArray(schema["required"])) out["required"] = schema["required"];
  }

  if (primary === "array") {
    const items = schema["items"];
    if (items && typeof items === "object") {
      out["items"] = toGeminiResponseSchema(items as JsonSchema);
    }
  }

  return out;
}

/** Throws when the payload violates the schema, so the ladder can try its next rung. */
export function parseExtraction(raw: string): Extraction {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("SCHEMA_VIOLATION: no JSON object");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;

  const format = String(parsed["answer_format"] ?? "");
  if (!(FORMATS as readonly string[]).includes(format)) {
    throw new Error("SCHEMA_VIOLATION: answer_format");
  }
  const rawBrands = Array.isArray(parsed["brands"]) ? parsed["brands"] : [];
  const brands: ExtractedBrand[] = [];
  for (const item of rawBrands) {
    const b = item as Record<string, unknown>;
    const name = typeof b["name"] === "string" ? b["name"].trim() : "";
    if (!name) continue;
    const type = String(b["mention_type"] ?? "mentioned");
    const position =
      typeof b["position"] === "number" && b["position"] > 0 ? Math.round(b["position"]) : null;
    brands.push({
      name,
      position,
      mention_type: ((TYPES as readonly string[]).includes(type)
        ? type
        : "mentioned") as ExtractedBrand["mention_type"],
      linked_url:
        typeof b["linked_url"] === "string" && b["linked_url"].startsWith("http")
          ? b["linked_url"]
          : null,
      evidence: typeof b["evidence"] === "string" ? b["evidence"].slice(0, 200) : null,
    });
  }
  const total = parsed["total_items"];
  return {
    answer_format: format as Extraction["answer_format"],
    total_items: typeof total === "number" ? Math.round(total) : brands.length || null,
    brands,
  };
}

/**
 * The little a stored brand needs for matching. Decoded from BrandRow, whose
 * `variants` and `domains` are JSON arrays in TEXT.
 */
export type MatchableBrand = {
  id: string;
  name: string;
  variants: string[];
  domains: string[];
};

export function resolveBrand(
  extracted: ExtractedBrand,
  brands: readonly MatchableBrand[],
): { brandId: string | null; isCited: boolean } {
  const host = linkHost(extracted.linked_url);
  const norm = normalizeName(extracted.name);

  let match = brands.find(
    (b) =>
      b.name.toLowerCase() === extracted.name.toLowerCase() ||
      b.variants.some((v) => v.toLowerCase() === extracted.name.toLowerCase()),
  );

  // An empty normal form matches anything else that normalises to empty, so a
  // name of pure punctuation must not be allowed to claim a brand.
  if (!match && norm) {
    match = brands.find(
      (b) => normalizeName(b.name) === norm || b.variants.some((v) => normalizeName(v) === norm),
    );
  }

  if (!match && host) {
    match = brands.find((b) => b.domains.some((d) => hostMatchesDomain(host, d)));
  }
  if (!match) return { brandId: null, isCited: false };

  // Shared with the recomputation that runs when a brand's domains are
  // corrected. See isCitation.
  return { brandId: match.id, isCited: isCitation(extracted.linked_url, match.domains) };
}

/**
 * The database side of turning a name into a brand id, injected so the shape of
 * an observation is decided here and the writing stays in the logic layer.
 */
export interface BrandResolver {
  /** Every brand in the project, cached for the pass. */
  list(): readonly MatchableBrand[];
  /** Insert a `discovered` brand, or null when a concurrent insert won. */
  create(name: string): string | null;
  /** Drop the cache after a write, so the next read sees the new row. */
  invalidate(): void;
}

/**
 * One observation row per extracted brand, in the extractor's order.
 *
 * Several observations of one brand in one answer stay separate rows. The
 * counting rule lives in finalizeRun, which groups by (task, brand), so one
 * answer counts as at most one mention per brand.
 */
export function buildObservations(
  extraction: Extraction,
  resolver: BrandResolver,
): ObservationInput[] {
  const rows: ObservationInput[] = [];

  for (const brand of extraction.brands) {
    let { brandId, isCited } = resolveBrand(brand, resolver.list());

    if (!brandId) {
      const created = resolver.create(brand.name);
      if (created) {
        brandId = created;
        // Re-decide the citation against the new brand. resolveBrand said
        // uncited only because it matched no brand. A new brand has no domains
        // yet, so an attributed link counts as its citation.
        isCited = isCitation(brand.linked_url, []);
      } else {
        // Someone else inserted the same name first. Re-read and re-resolve so
        // the observation lands on their row rather than on nothing.
        resolver.invalidate();
        const again = resolveBrand(brand, resolver.list());
        brandId = again.brandId;
        isCited = again.isCited;
      }
      resolver.invalidate();
    }

    rows.push({
      brandId,
      rawName: brand.name,
      position: brand.position,
      totalItems: extraction.total_items,
      mentionType: brand.mention_type,
      linkedUrl: brand.linked_url,
      isCited,
      evidence: brand.evidence,
    });
  }

  return rows;
}
