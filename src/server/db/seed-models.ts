/**
 * The model catalogue. Nine rows: three per provider, one extraction model
 * each.
 *
 * Ids are fixed literals, not freshly generated UUIDs, because the seed upserts
 * on the primary key and has to recognise a row it wrote on a previous boot.
 * That is what lets a user switch a model off in Settings and keep it off:
 * re-seeding refreshes the catalogue facts (name, tier, prices, capabilities)
 * and never touches `is_active`.
 *
 * `extraction_rank`: lower is preferred, and the three extraction models are
 * ranked cheapest first by input price. Every price is a published list rate
 * and is shown to the user as an estimate.
 */
import type { Driver } from "./driver";
import type { ModelProvider, ModelTier } from "./types";

export interface CatalogueModel {
  id: string;
  provider: ModelProvider;
  model_id: string;
  display_name: string;
  tier: ModelTier;
  supports_web_search: boolean;
  input_price_per_mtok: number;
  output_price_per_mtok: number;
  search_price_per_call: number;
  is_extraction_model: boolean;
  extraction_rank: number | null;
}

export const CATALOGUE: readonly CatalogueModel[] = [
  {
    id: "09fbf457-be35-4428-b72b-48bc04fcc01e",
    provider: "anthropic",
    model_id: "claude-haiku-4-5",
    display_name: "Claude Haiku 4.5",
    tier: "extraction",
    supports_web_search: false,
    input_price_per_mtok: 1.0,
    output_price_per_mtok: 5.0,
    search_price_per_call: 0,
    is_extraction_model: true,
    extraction_rank: 3,
  },
  {
    id: "8e4393f7-aaaf-415f-b52c-fec4b4166501",
    provider: "anthropic",
    model_id: "claude-sonnet-5",
    display_name: "Claude Sonnet 5",
    tier: "mid",
    supports_web_search: true,
    input_price_per_mtok: 3.0,
    output_price_per_mtok: 15.0,
    search_price_per_call: 0.01,
    is_extraction_model: false,
    extraction_rank: null,
  },
  {
    id: "a6f6e3cc-c606-48a7-8c06-0f8da775eb78",
    provider: "anthropic",
    model_id: "claude-opus-5",
    display_name: "Claude Opus 5",
    tier: "frontier",
    supports_web_search: true,
    input_price_per_mtok: 5.0,
    output_price_per_mtok: 25.0,
    search_price_per_call: 0.01,
    is_extraction_model: false,
    extraction_rank: null,
  },
  {
    id: "e473c6ad-df52-4ee6-bf96-f7913077f8d1",
    provider: "openai",
    model_id: "gpt-5.6-luna",
    display_name: "GPT-5.6 Luna",
    tier: "extraction",
    supports_web_search: false,
    input_price_per_mtok: 0.2,
    output_price_per_mtok: 1.2,
    search_price_per_call: 0,
    is_extraction_model: true,
    extraction_rank: 1,
  },
  {
    id: "ec1fe773-7819-434c-8fd1-470f91aca4bb",
    provider: "openai",
    model_id: "gpt-5.6-terra",
    display_name: "GPT-5.6 Terra",
    tier: "mid",
    supports_web_search: true,
    input_price_per_mtok: 2.0,
    output_price_per_mtok: 12.0,
    search_price_per_call: 0.01,
    is_extraction_model: false,
    extraction_rank: null,
  },
  {
    id: "d40e8d7d-ff20-4fbf-a48c-08035e06d0f5",
    provider: "openai",
    model_id: "gpt-5.6-sol",
    display_name: "GPT-5.6 Sol",
    tier: "frontier",
    supports_web_search: true,
    input_price_per_mtok: 5.0,
    output_price_per_mtok: 30.0,
    search_price_per_call: 0.01,
    is_extraction_model: false,
    extraction_rank: null,
  },
  {
    id: "695e8bbd-b115-4c03-84b0-f91e20890a13",
    provider: "google",
    model_id: "gemini-3.1-flash-lite",
    display_name: "Gemini 3.1 Flash-Lite",
    tier: "extraction",
    supports_web_search: false,
    input_price_per_mtok: 0.25,
    output_price_per_mtok: 1.5,
    search_price_per_call: 0,
    is_extraction_model: true,
    extraction_rank: 2,
  },
  {
    // Google's id carries the -preview suffix; `gemini-3.1-pro` returns 404.
    id: "4c6d7872-1806-4b76-948b-4ef539768006",
    provider: "google",
    model_id: "gemini-3.1-pro-preview",
    display_name: "Gemini 3.1 Pro Preview",
    tier: "frontier",
    supports_web_search: true,
    input_price_per_mtok: 2.0,
    output_price_per_mtok: 12.0,
    search_price_per_call: 0.014,
    is_extraction_model: false,
    extraction_rank: null,
  },
  {
    // The flash model is the mid tier and the pro model above it is frontier.
    // Tier is a label the wizard groups by, not a price: these two cost the
    // same.
    id: "b9e060b8-0fc3-4bb2-8b67-a43518acd777",
    provider: "google",
    model_id: "gemini-3.6-flash",
    display_name: "Gemini 3.6 Flash",
    tier: "mid",
    supports_web_search: true,
    input_price_per_mtok: 2.0,
    output_price_per_mtok: 12.0,
    search_price_per_call: 0.014,
    is_extraction_model: false,
    extraction_rank: null,
  },
];

const UPSERT = `
INSERT INTO models (
  id, provider, model_id, display_name, tier, supports_web_search,
  input_price_per_mtok, output_price_per_mtok, search_price_per_call,
  is_extraction_model, extraction_rank, is_active, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
ON CONFLICT(id) DO UPDATE SET
  provider              = excluded.provider,
  model_id              = excluded.model_id,
  display_name          = excluded.display_name,
  tier                  = excluded.tier,
  supports_web_search   = excluded.supports_web_search,
  input_price_per_mtok  = excluded.input_price_per_mtok,
  output_price_per_mtok = excluded.output_price_per_mtok,
  search_price_per_call = excluded.search_price_per_call,
  is_extraction_model   = excluded.is_extraction_model,
  extraction_rank       = excluded.extraction_rank`;

/**
 * Write the catalogue. Idempotent, and never resets `is_active`, which belongs
 * to the user.
 */
export function seedModels(db: Driver, catalogue: readonly CatalogueModel[] = CATALOGUE): void {
  const now = new Date().toISOString();
  const upsert = db.prepare(UPSERT);
  // The table has two unique keys and the upsert can only name one of them. A
  // catalogue row that keeps its provider and model_id under a new uuid would
  // hit models_provider_model_idx and throw out of getDb() on every request.
  //
  // So (provider, model_id) is the identity and the uuid a handle: when a row
  // for that pair exists, it is updated in place under the id it already has.
  // Deleting it is not an option, because run_tasks and run_metrics reference
  // models(id) and a user's history would be refused or lost.
  const existingId = db.prepare("SELECT id FROM models WHERE provider = ? AND model_id = ?");

  db.transaction(() => {
    for (const m of catalogue) {
      const held = existingId.get<{ id: string }>(m.provider, m.model_id)?.id;
      upsert.run(
        held ?? m.id,
        m.provider,
        m.model_id,
        m.display_name,
        m.tier,
        m.supports_web_search ? 1 : 0,
        m.input_price_per_mtok,
        m.output_price_per_mtok,
        m.search_price_per_call,
        m.is_extraction_model ? 1 : 0,
        m.extraction_rank,
        now,
      );
    }
  });
}
