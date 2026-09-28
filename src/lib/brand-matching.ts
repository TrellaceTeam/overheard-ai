/**
 * Resolving an extracted brand to a known one: name normalisation, and matching
 * a link's host against a brand's stored domains.
 *
 * Free of server imports, because both sides use it. The browser checks a
 * domain by the same rules matching uses. The server uses it in extraction, in
 * the worker, and in the metric reads that decide which prompts are
 * self-referenced. Extraction and self-reference detection must normalise a
 * name the same way, or "is Acme good?" is not recognised as naming "Acme Inc"
 * and the prompt inflates mention rate.
 */

/**
 * A link's host: lowercased, `www.` stripped, nothing collapsed.
 *
 * It never trims to the last two labels. On a multi-label suffix that gives the
 * registry (`acme.co.uk` becomes `co.uk`), and every link to any `.co.uk` site
 * would count as a citation for every brand stored on one. Subdomains are kept:
 * whether `blog.acme.co.uk` belongs to `acme.co.uk` is for matching to decide.
 */
export function linkHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const { hostname, protocol } = new URL(url);
    // A javascript: or data: URL parses but has no host worth matching on.
    if (protocol !== "http:" && protocol !== "https:") return null;
    const host = hostname.toLowerCase().replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

/**
 * A stored domain reduced to the shape a link host has: no scheme, no `www.`,
 * no path, lowercased.
 *
 * Input validation uses it too. If the form and matching disagreed about what a
 * domain looks like, a value could pass the form and never match anything.
 */
export function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "");
}

/**
 * Whether a link's host belongs to a stored domain.
 *
 * A suffix match at a label boundary, which holds on every top-level domain
 * without a public suffix list. It errs toward a missed citation, never an
 * invented one. The boundary matters: `"notacme.com".endsWith("acme.com")` is
 * true, so a bare string suffix would attribute a competitor's site to you.
 */
export function hostMatchesDomain(
  host: string | null | undefined,
  storedDomain: string | null | undefined,
): boolean {
  if (!host || !storedDomain) return false;
  const h = normalizeDomain(host);
  const d = normalizeDomain(storedDomain);
  if (!h || !d) return false;
  return h === d || h.endsWith(`.${d}`);
}

/** Word-boundary legal suffixes. `\b` keeps `co` out of `contoso`. */
const LEGAL = /\b(inc|llc|ltd|limited|gmbh|corp|corporation|co|plc|sa|bv|ag)\b/g;

/** Straight and typographic apostrophes, quotes, and sentence punctuation. */
const PUNCTUATION = /[.,'‘’"“”`]/g;

/**
 * A brand name reduced to the form two spellings of the same brand share.
 *
 * Parenthetical qualifiers are removed whole, before punctuation, so the forms
 * an assistant produces for one product collapse into one:
 *
 *   Northstar · Northstar (by Acme Analytics) · Northstar (Acme Analytics)
 *
 * Treating the parens as punctuation would leave `northstar by acme analytics`,
 * which matches nothing.
 *
 * Vendor prefixes are not stripped. `Acme Northstar` stays distinct from
 * `Northstar`: telling a vendor from part of a product name needs knowledge
 * this function lacks, and the same rule would merge `Globex Search Console`
 * into `Search Console`. Those cases belong in `brands.variants`, which the
 * worker learns, or in a manual merge.
 */
export function normalizeName(name: string): string {
  return name
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .replace(PUNCTUATION, " ")
    .replace(LEGAL, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Whether a value has the shape of a domain a citation could match.
 *
 * A value like `acme.`, with a trailing dot and no top-level label, would
 * otherwise be stored, match nothing, and hold citation rate at 0% with nothing
 * on screen to tell it apart from "no assistant links you".
 *
 * The check is structural: at least two labels, each made of letters, digits
 * and interior hyphens, and a top-level label of at least two letters. It does
 * not ask whether the domain resolves or the TLD is on the IANA list, because a
 * new company's domain may not resolve yet. A bare hostname like `localhost`
 * and a raw IP address fail, since a brand is never cited at either.
 */
export function isPlausibleDomain(value: string): boolean {
  const domain = normalizeDomain(value);
  if (!domain || /\s/.test(domain)) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label))) return false;
  return /^[a-z]{2,}$/.test(labels.at(-1) ?? "");
}

/**
 * Whether an answer's link counts as a citation for a brand.
 *
 * Applied when an answer is extracted and again when a brand's domains are
 * corrected, so both paths count citations the same way. No link is never a
 * citation: a brand named in prose without a link is mentioned, not cited.
 *
 * A brand with no stored domains counts any attributed link. Newly discovered
 * competitors arrive with no domains and are seeded from these links, so
 * dropping the link would lose the only evidence of where they live. A brand
 * with domains must match one of them.
 */
export function isCitation(
  linkedUrl: string | null | undefined,
  domains: readonly string[] | null | undefined,
): boolean {
  const host = linkHost(linkedUrl);
  if (!host) return false;
  const known = (domains ?? []).filter((d) => d?.trim());
  if (known.length === 0) return true;
  return known.some((domain) => hostMatchesDomain(host, domain));
}
