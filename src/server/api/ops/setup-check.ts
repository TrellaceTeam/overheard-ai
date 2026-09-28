/**
 * The setup check: prove, before money is spent on a run, that every model a
 * project will call works with the user's keys.
 *
 * Each selected assistant is probed with web search forced against the exact
 * model a run would use (searchCheck), and the extractor with a short call in
 * the shape an extraction uses (extractorCheck). One row per model comes back,
 * with status, message and fix hint, plus the instant the check ran, so a
 * caller can tell a fresh pass from a stale one. Keys are read inside the
 * worker layer and never pass through here.
 */
import type { Provider } from "../../db/types";
import type { Driver } from "../../db/driver";
import type { SearchCheckResult } from "@/lib/setup-check";
import { noSearchCapableModel } from "@/lib/setup-check";
import { pickExtractor } from "@/lib/onboarding";
import { extractorCheck, searchCheck, searchCheckModelId } from "../../worker/providers";
import { listExtractionModels } from "./models";
import { InvalidInputError, NotFoundError } from "./shared";

export type SetupCheckKind = "assistant" | "extractor";

export interface SetupCheckRow {
  kind: SetupCheckKind;
  provider: Provider;
  /** The provider's own model id, which is what a probe calls. Null when the provider has no search-capable model catalog. */
  modelId: string | null;
  displayName: string;
  result: SearchCheckResult;
}

export interface SetupCheckReport {
  /** ISO instant, so a caller can decide whether the report is still fresh. */
  checkedAt: string;
  rows: SetupCheckRow[];
}

/**
 * Injected in tests so the operation runs with no network. The fourth argument
 * is an extractor target's system prompt. extractorCheck defaults it to
 * EXTRACTION_SYSTEM.
 */
export type SetupProbe = (
  kind: SetupCheckKind,
  provider: Provider,
  modelId: string,
  systemPrompt?: string | undefined,
) => Promise<SearchCheckResult>;

const defaultProbe: SetupProbe = (kind, provider, modelId, systemPrompt) =>
  kind === "assistant"
    ? searchCheck(provider, modelId)
    : extractorCheck(provider, modelId, undefined, systemPrompt);

interface Target {
  kind: SetupCheckKind;
  provider: Provider;
  modelId: string | null;
  displayName: string;
  /** Read only for an extractor target. */
  systemPrompt?: string | undefined;
}

async function runTargets(
  targets: Target[],
  run: (target: Target) => Promise<SearchCheckResult>,
): Promise<SetupCheckReport> {
  const rows = await Promise.all(
    targets.map(async (target) => ({
      ...target,
      result: await run(target),
    })),
  );
  return { checkedAt: new Date().toISOString(), rows };
}

/**
 * A provider-level check, for screens with no project: probe the catalog's
 * representative search-capable model for each provider named. A provider with
 * no search-capable model catalog gets a row that says so instead of being
 * skipped.
 */
export function checkProviders(
  providers: readonly Provider[],
  probe: SetupProbe = defaultProbe,
): Promise<SetupCheckReport> {
  const targets: Target[] = providers.map((provider) => {
    const modelId = searchCheckModelId(provider);
    return {
      kind: "assistant" as const,
      provider,
      modelId,
      displayName: modelId ?? provider,
    };
  });
  return runTargets(targets, guarded(probe));
}

/** Answers the no-model row without a call. Everything else goes to the probe. */
function guarded(probe: SetupProbe): (target: Target) => Promise<SearchCheckResult> {
  return ({ kind, provider, modelId, systemPrompt }) =>
    modelId === null
      ? Promise.resolve(noSearchCapableModel(provider))
      : probe(kind, provider, modelId, systemPrompt);
}

export interface CheckSelectionInput {
  /** Database ids of the assistants to probe, as the wizard holds them. */
  assistantModelIds: readonly string[];
  /**
   * The extractor, resolved as createProject resolves it: both use the pick
   * rule in lib/extraction-choice. Omitted auto-picks the cheapest extractor
   * whose provider has a key, null checks none, and a string names one. A
   * check that probed a different extractor than the project will use would
   * prove nothing.
   */
  extractorModelId?: string | null | undefined;
  /** Providers with a key in this process's environment, for the auto-pick. */
  providersWithKeys?: readonly string[] | undefined;
}

/**
 * Check a selection that does not belong to a project yet: the assistants the
 * wizard has ticked plus the extractor a create would resolve. It validates
 * models as createProject does (NO_MODELS, MODEL_NOT_FOUND), so the check
 * cannot pass a selection that create would then refuse.
 */
export async function checkSelection(
  db: Driver,
  input: CheckSelectionInput,
  probe: SetupProbe = defaultProbe,
): Promise<SetupCheckReport> {
  const unique = [...new Set(input.assistantModelIds.filter((id) => id.trim() !== ""))];
  if (unique.length === 0) {
    throw new InvalidInputError("NO_MODELS", "choose at least one assistant to ask");
  }

  const targets: Target[] = unique.map((id) => {
    const row = db
      .prepare("SELECT model_id, provider, display_name FROM models WHERE id = ? AND is_active = 1")
      .get<{ model_id: string; provider: Provider; display_name: string }>(id);
    if (!row) throw new NotFoundError("MODEL_NOT_FOUND", `${id} is not in the catalog`);
    return {
      kind: "assistant" as const,
      provider: row.provider,
      modelId: row.model_id,
      displayName: row.display_name,
    };
  });

  let extractorId = input.extractorModelId;
  if (extractorId === undefined) {
    extractorId =
      pickExtractor(listExtractionModels(db), [...(input.providersWithKeys ?? [])])?.id ?? null;
  }
  if (extractorId !== null) {
    const row = db
      .prepare(
        "SELECT model_id, provider, display_name FROM models WHERE id = ? AND is_extraction_model = 1 AND is_active = 1",
      )
      .get<{ model_id: string; provider: Provider; display_name: string }>(extractorId);
    if (!row) throw new NotFoundError("MODEL_NOT_FOUND", "that extractor is not in the catalog");
    targets.push({
      kind: "extractor",
      provider: row.provider,
      modelId: row.model_id,
      displayName: row.display_name,
    });
  }

  return runTargets(targets, guarded(probe));
}
