/**
 * Reading a perception answer into sections, and merging those across
 * assistants.
 *
 * Both contracts return the same four fields, because the dashboard shows the
 * same four headings for one assistant or for all of them, and the band renders
 * a per-assistant row and the aggregate row with one component.
 *
 * Not sentiment: no score, no polarity, no strength. "Downsides" is the
 * criticism the assistant itself volunteered, in its own words.
 */
import type { Driver } from "../db/driver";
import type { ProviderResult } from "./providers";
import {
  countPerceptionTasks,
  listDonePerceptionTasks,
  listModelDisplayNames,
  listPerAssistantSummaries,
  targetBrandName,
} from "./queries";
import { writePerceptionSummary } from "../logic/perception-summary";

export type PerceptionFields = {
  /** False when the assistant said it did not recognise the brand. */
  knows_brand: boolean;
  what_it_does: string;
  typical_customers: string;
  well_regarded_for: string;
  downsides: string;
};

/** The four headings, in the order the dashboard shows them. */
export const PERCEPTION_SECTIONS = [
  { key: "what_it_does", label: "What it does" },
  { key: "typical_customers", label: "Typical customers" },
  { key: "well_regarded_for", label: "Well regarded for" },
  { key: "downsides", label: "Downsides" },
] as const satisfies ReadonlyArray<{ key: keyof PerceptionFields; label: string }>;

const SHARED_RULES = `Rules:
1. Every field must come from the text you are given. Do not add knowledge of
   your own, do not infer, and do not fill a gap by guessing. This is a record
   of what was said, not an assessment of the brand.
2. Use an empty string for any field the text does not cover. An empty field is
   a finding; an invented one is a lie.
3. Write plainly, in the third person, in at most two sentences per field. No
   bullet points, no headings, no markdown.
4. Do not grade, score or rate anything. "downsides" holds only criticisms the
   text itself raises, in its own terms.
5. Set knows_brand false when the text says it is unfamiliar with the brand,
   cannot find it, or is confusing it with something else. When it is false,
   every other field is usually empty, and that is correct.`;

const SCHEMA = `Schema:
{"knows_brand":boolean,"what_it_does":string,"typical_customers":string,
 "well_regarded_for":string,"downsides":string}`;

export const PERCEPTION_SYSTEM = `You read one AI assistant's description of a brand and sort what it said into
four fields. Return only JSON matching the schema. Do not add commentary.

${SCHEMA}

${SHARED_RULES}`;

export const PERCEPTION_SYNTHESIS_SYSTEM = `You merge several AI assistants' descriptions of the same brand into one
summary. Return only JSON matching the schema. Do not add commentary.

${SCHEMA}

${SHARED_RULES}
6. Where the assistants agree, state it once. Where they disagree on something
   that matters, say so and name them, for example "Claude describes them as
   enterprise-focused, while OpenAI and Gemini describe mid-market".
7. Set knows_brand true if any assistant recognised the brand. Do not mention
   the ones that did not; that is counted separately.`;

/**
 * The slice is a backstop, as in extractionUserPrompt. A perception answer has
 * the same answer token cap, so it should never bind.
 */
export function perceptionUserPrompt(brand: string, answerText: string): string {
  return `The brand is: ${brand}\n\nWhat an assistant said about it:\n---\n${answerText.slice(0, 34_000)}\n---`;
}

export function perceptionSynthesisPrompt(
  brand: string,
  perAssistant: ReadonlyArray<{ assistant: string; fields: PerceptionFields }>,
): string {
  const blocks = perAssistant
    .map(({ assistant, fields }) =>
      [
        `Assistant: ${assistant}`,
        `What it does: ${fields.what_it_does || "(not covered)"}`,
        `Typical customers: ${fields.typical_customers || "(not covered)"}`,
        `Well regarded for: ${fields.well_regarded_for || "(not covered)"}`,
        `Downsides: ${fields.downsides || "(not covered)"}`,
      ].join("\n"),
    )
    .join("\n\n");
  return `The brand is: ${brand}\n\n${blocks}`;
}

const EMPTY: PerceptionFields = {
  knows_brand: false,
  what_it_does: "",
  typical_customers: "",
  well_regarded_for: "",
  downsides: "",
};

function field(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string") return "";
  // A model that has nothing to say sometimes says so in the field rather than
  // leaving it empty. Those read as content and would be shown as a finding.
  const text = value.trim();
  if (!text) return "";
  if (/^\(?(n\/?a|none|not (covered|mentioned|stated|specified)|unknown)\)?\.?$/i.test(text)) {
    return "";
  }
  return text.slice(0, 1_200);
}

/** Throws when the payload violates the schema, so the caller can retry once. */
export function parsePerception(raw: string): PerceptionFields {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("SCHEMA_VIOLATION: no JSON object");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;

  if (typeof parsed["knows_brand"] !== "boolean") {
    throw new Error("SCHEMA_VIOLATION: knows_brand");
  }

  return {
    ...EMPTY,
    knows_brand: parsed["knows_brand"],
    what_it_does: field(parsed, "what_it_does"),
    typical_customers: field(parsed, "typical_customers"),
    well_regarded_for: field(parsed, "well_regarded_for"),
    downsides: field(parsed, "downsides"),
  };
}

/** Whether a summary has anything worth rendering. */
export function hasContent(fields: PerceptionFields): boolean {
  return PERCEPTION_SECTIONS.some((section) => fields[section.key].trim().length > 0);
}

/** A stored row read back as fields. A null knows_brand reads as true. */
export function fieldsOf(row: {
  knows_brand: number | boolean | null;
  what_it_does: string | null;
  typical_customers: string | null;
  well_regarded_for: string | null;
  downsides: string | null;
}): PerceptionFields {
  return {
    knows_brand: row.knows_brand !== 0 && row.knows_brand !== false,
    what_it_does: row.what_it_does ?? "",
    typical_customers: row.typical_customers ?? "",
    well_regarded_for: row.well_regarded_for ?? "",
    downsides: row.downsides ?? "",
  };
}

/** What the merge needs from the worker: one extraction-tier call, and a log. */
export interface PerceptionMergeDeps {
  /**
   * The synthesis call, already resolved to an extraction model and a key.
   * Null when no extractor is available, in which case the merge is skipped and
   * the per-assistant rows stand on their own.
   */
  call: ((system: string, user: string) => Promise<ProviderResult>) | null;
  /** Records the synthesis call against the first done perception task. */
  recordUsage: (anchorTaskId: string, result: ProviderResult) => void;
}

/**
 * Merges the per-assistant summaries into the across-assistants row.
 *
 * Runs once a run has drained, not per task: the aggregate needs every
 * assistant's answer, and a per-task hook would merge with the rest still in
 * flight.
 *
 * Project-scoped, not run-scoped. It merges the current per-assistant rows,
 * which may include an assistant from an earlier perception run that was not
 * asked again this time.
 *
 * A single assistant's summary becomes the aggregate as it is, with no call.
 *
 * A failure loses nothing: the per-assistant rows are already stored, and the
 * band shows them side by side instead. There is no retry.
 */
export async function summarisePerception(
  db: Driver,
  runId: string,
  projectId: string,
  deps: PerceptionMergeDeps,
): Promise<void> {
  if (countPerceptionTasks(db, runId) === 0) return;

  const done = listDonePerceptionTasks(db, runId, 50);
  if (done.length === 0) return;

  const perModel = listPerAssistantSummaries(db, projectId);
  if (perModel.length === 0) return;

  const question = done[0]?.question_text ?? null;
  const first = perModel[0];

  if (perModel.length === 1 && first) {
    writePerceptionSummary(db, projectId, null, {
      ...fieldsOf(first),
      run_id: runId,
      question_text: question,
      source_answers: 1,
    });
    return;
  }

  if (!deps.call) return;

  const nameOf = listModelDisplayNames(
    db,
    perModel.map((row) => row.model_id).filter((id): id is string => id !== null),
  );

  // Only the assistants that recognised the brand are merged. Empty summaries
  // would make an aggregate that reads as "we know nothing" instead of
  // "nobody had heard of you", which is counted separately.
  const known = perModel.filter((row) => row.knows_brand !== 0);
  const forPrompt = (known.length > 0 ? known : perModel).map((row) => ({
    assistant: (row.model_id ? nameOf.get(row.model_id) : undefined) ?? "An assistant",
    fields: fieldsOf(row),
  }));

  const brand = targetBrandName(db, projectId);
  let fields: PerceptionFields;
  let result: ProviderResult;
  try {
    result = await deps.call(
      PERCEPTION_SYNTHESIS_SYSTEM,
      perceptionSynthesisPrompt(brand, forPrompt),
    );
    fields = parsePerception(result.text);
  } catch (err) {
    console.error("[worker] perception synthesis failed", {
      run_id: runId,
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  writePerceptionSummary(db, projectId, null, {
    ...fields,
    // Decided here, not by the model: whether any assistant recognised the
    // brand is already known.
    knows_brand: known.length > 0,
    run_id: runId,
    question_text: question,
    source_answers: perModel.length,
  });

  const anchor = done[0];
  if (anchor) deps.recordUsage(anchor.id, result);
}
