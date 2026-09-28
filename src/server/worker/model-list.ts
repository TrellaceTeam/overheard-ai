/**
 * The models a provider key can use, read from the provider's own list
 * endpoint. The list calls cost nothing, and they go only to a provider the
 * user already has a key for.
 *
 * The key goes in a header, as on every other call, and never into a URL, a
 * log line or an error message.
 */
import type { Provider } from "../db/types";
import { ProviderError, scrubError } from "./providers";

/** Long enough for a paged list, short enough that a stuck provider does not hold a screen. */
const LIST_TIMEOUT_MS = 15_000;

/** A safety stop for a paged list that never ends. */
const MAX_PAGES = 20;

type Fetch = typeof fetch;

async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: Fetch,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(scrubError(`HTTP ${res.status}: ${text}`), res.status, "HTTP");
    }
    return (await res.json()) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    const message = controller.signal.aborted
      ? `TIMEOUT after ${LIST_TIMEOUT_MS}ms`
      : String((error as Error)?.message ?? error);
    throw new ProviderError(scrubError(message), 0, "NETWORK");
  } finally {
    clearTimeout(timer);
  }
}

/** Every model id the key can use, as the provider spells it. */
export async function listKeyModels(
  provider: Provider,
  apiKey: string,
  fetchImpl: Fetch = fetch,
): Promise<string[]> {
  switch (provider) {
    case "openai": {
      const json = await getJson(
        "https://api.openai.com/v1/models",
        { authorization: `Bearer ${apiKey}` },
        fetchImpl,
      );
      return ((json["data"] ?? []) as Array<{ id?: string }>).flatMap((m) => (m.id ? [m.id] : []));
    }
    case "anthropic": {
      const ids: string[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const url = new URL("https://api.anthropic.com/v1/models");
        url.searchParams.set("limit", "1000");
        if (after) url.searchParams.set("after_id", after);
        const json = await getJson(
          url.toString(),
          { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
          fetchImpl,
        );
        for (const model of (json["data"] ?? []) as Array<{ id?: string }>) {
          if (model.id) ids.push(model.id);
        }
        const next = json["has_more"] === true ? (json["last_id"] as string | undefined) : null;
        if (!next) break;
        after = next;
      }
      return ids;
    }
    case "google": {
      const ids: string[] = [];
      let token: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
        url.searchParams.set("pageSize", "1000");
        if (token) url.searchParams.set("pageToken", token);
        const json = await getJson(url.toString(), { "x-goog-api-key": apiKey }, fetchImpl);
        for (const model of (json["models"] ?? []) as Array<{ name?: string }>) {
          // Listed as "models/gemini-3.8-flash".
          if (model.name) ids.push(model.name.replace(/^models\//, ""));
        }
        token = (json["nextPageToken"] as string | undefined) ?? null;
        if (!token) break;
      }
      return ids;
    }
  }
}

/**
 * Whether a catalogue id is on the list. A provider can list a dated snapshot
 * (`claude-haiku-4-5-20251001`) for an id the catalogue writes without the
 * date, so a date suffix counts as the same model.
 */
export function listedModel(catalogueId: string, listed: ReadonlySet<string>): boolean {
  if (listed.has(catalogueId)) return true;
  for (const id of listed) {
    if (!id.startsWith(`${catalogueId}-`)) continue;
    if (/^\d{4}-?\d{2}-?\d{2}$/.test(id.slice(catalogueId.length + 1))) return true;
  }
  return false;
}
