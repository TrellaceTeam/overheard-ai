/**
 * The provider API-key facts a browser may see: the environment variable that
 * carries each provider's key (in the order they are tried, Google's accepted
 * alias included) and the page where a key is created, the same links
 * `.env.example` carries.
 *
 * The server's key reader imports the names from here, so no screen can name
 * a variable the reader does not read. Key values never leave the server.
 */
export const PROVIDER_KEY_ENV = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
} as const;

export type KeyProvider = keyof typeof PROVIDER_KEY_ENV;

/** Display order, matching the keys panel and .env.example. */
export const PROVIDER_KEY_PAGES: ReadonlyArray<{ provider: KeyProvider; url: string }> = [
  { provider: "openai", url: "https://platform.openai.com/api-keys" },
  { provider: "anthropic", url: "https://console.anthropic.com/settings/keys" },
  { provider: "google", url: "https://aistudio.google.com/apikey" },
];

/**
 * The variable names for one provider as a sentence fragment:
 * "OPENAI_API_KEY", or "GOOGLE_API_KEY (or GEMINI_API_KEY)" where an alias is
 * accepted, so a user who followed Google's own quickstart can see that their
 * variable already works.
 */
export function keyEnvNames(provider: KeyProvider): string {
  const names = PROVIDER_KEY_ENV[provider];
  return names.length === 1 ? names[0] : `${names[0]} (or ${names[1]})`;
}

/**
 * keyEnvNames for a provider slug that came off a wire or out of a regex and
 * may be anything. Null for an unknown slug, so the caller can supply its own
 * generic fragment.
 */
export function keyEnvNamesSafe(slug: string): string | null {
  return slug in PROVIDER_KEY_ENV ? keyEnvNames(slug as KeyProvider) : null;
}
