import { describe, expect, it } from "vitest";
import {
  hostMatchesDomain,
  isCitation,
  isPlausibleDomain,
  linkHost,
  normalizeDomain,
  normalizeName,
} from "./brand-matching";

describe("linkHost", () => {
  it("returns a bare host, lowercased, without www", () => {
    expect(linkHost("https://WWW.Acme.co.uk/pricing?x=1")).toBe("acme.co.uk");
  });

  it("never collapses to a public suffix", () => {
    // Trimming to the last two labels gives "co.uk" here, which would match
    // every brand on a .co.uk domain and invent citations for all of them.
    expect(linkHost("https://acme.co.uk")).toBe("acme.co.uk");
    expect(linkHost("https://blog.acme.co.uk")).toBe("blog.acme.co.uk");
  });

  it("keeps subdomains, because matching decides what to do with them", () => {
    expect(linkHost("https://docs.example.com/a/b")).toBe("docs.example.com");
  });

  it("returns null for anything unparseable", () => {
    for (const bad of [null, "", "not a url", "javascript:alert(1)"]) {
      expect(linkHost(bad)).toBeNull();
    }
  });
});

describe("hostMatchesDomain", () => {
  it("matches the domain itself", () => {
    expect(hostMatchesDomain("acme.co.uk", "acme.co.uk")).toBe(true);
  });

  it("matches a subdomain of a stored domain", () => {
    expect(hostMatchesDomain("blog.acme.co.uk", "acme.co.uk")).toBe(true);
    expect(hostMatchesDomain("a.b.acme.com", "acme.com")).toBe(true);
  });

  it("does NOT match an unrelated site sharing a multi-label TLD", () => {
    // Sharing a registry suffix does not make two sites one owner's.
    expect(hostMatchesDomain("someblog.co.uk", "acme.co.uk")).toBe(false);
    expect(hostMatchesDomain("competitor.co.uk", "acme.co.uk")).toBe(false);
  });

  it("requires a label boundary, not a bare string suffix", () => {
    // "notacme.com".endsWith("acme.com") is true, so the match needs the dot.
    expect(hostMatchesDomain("notacme.com", "acme.com")).toBe(false);
    expect(hostMatchesDomain("myacme.co.uk", "acme.co.uk")).toBe(false);
  });

  it("is case- and www-insensitive on both sides", () => {
    expect(hostMatchesDomain("BLOG.Acme.COM", "www.ACME.com")).toBe(true);
    expect(hostMatchesDomain("www.acme.com", "acme.com")).toBe(true);
  });

  it("is correct on every multi-label TLD, not just .co.uk", () => {
    for (const tld of ["co.uk", "com.au", "co.nz", "co.jp"]) {
      expect(hostMatchesDomain(`acme.${tld}`, `acme.${tld}`)).toBe(true);
      expect(hostMatchesDomain(`other.${tld}`, `acme.${tld}`)).toBe(false);
    }
  });

  it("never matches on empty or missing input", () => {
    expect(hostMatchesDomain(null, "acme.com")).toBe(false);
    expect(hostMatchesDomain("acme.com", "")).toBe(false);
    expect(hostMatchesDomain("", "acme.com")).toBe(false);
  });
});

describe("normalizeName", () => {
  it("collapses a parenthetical qualifier onto the bare name", () => {
    // An assistant writes one product several ways. These three become one.
    const bare = normalizeName("Contoso");
    expect(normalizeName("Contoso (by Acme Analytics)")).toBe(bare);
    expect(normalizeName("Contoso (Acme Analytics)")).toBe(bare);
  });

  it("collapses a product family that shares a parenthetical", () => {
    expect(normalizeName("Fabrikam EPC (Enterprise Product Costing)")).toBe(
      normalizeName("Fabrikam EPC"),
    );
  });

  it("strips legal suffixes, so a question and an answer agree", () => {
    // Extraction and self-reference detection both normalise with this, so
    // "is Acme good?" is detected as naming a brand called "Acme Inc".
    expect(normalizeName("Acme Inc")).toBe(normalizeName("Acme"));
    expect(normalizeName("Acme Ltd.")).toBe(normalizeName("Acme"));
    expect(normalizeName("Acme GmbH")).toBe(normalizeName("Acme"));
  });

  it("does not strip a legal suffix that is part of a word", () => {
    // "co" must not eat the "co" in "contoso".
    expect(normalizeName("Contoso")).toBe("contoso");
    expect(normalizeName("Incentive")).toBe("incentive");
  });

  it("treats straight and typographic apostrophes alike", () => {
    expect(normalizeName("Globex’s")).toBe(normalizeName("Globex's"));
    expect(normalizeName("Globex‘s")).toBe(normalizeName("Globex's"));
  });

  it("is idempotent", () => {
    for (const name of [
      "Contoso (by Acme Analytics)",
      "Acme Inc",
      "Fabrikam EPC Suite",
      "Globex’s",
      "  spaced   out  ",
    ]) {
      const once = normalizeName(name);
      expect(normalizeName(once)).toBe(once);
    }
  });

  it("does not collapse genuinely different products", () => {
    // A shared word is not a shared brand.
    expect(normalizeName("Fabrikam EPC")).not.toBe(normalizeName("Fabrikam"));
    expect(normalizeName("Globex Search")).not.toBe(normalizeName("Search"));
  });

  it("returns empty for a name that is only punctuation", () => {
    expect(normalizeName("()")).toBe("");
    expect(normalizeName("   ")).toBe("");
  });
});

describe("normalizeDomain", () => {
  it("reduces a stored value to the shape a link host has", () => {
    expect(normalizeDomain("HTTPS://WWW.Acme.com/pricing?x=1")).toBe("acme.com");
    expect(normalizeDomain("  acme.co.uk  ")).toBe("acme.co.uk");
  });

  it("keeps subdomains, which matching decides about", () => {
    expect(normalizeDomain("https://blog.acme.com")).toBe("blog.acme.com");
  });
});

describe("isPlausibleDomain", () => {
  it("accepts an ordinary domain, however it was typed", () => {
    for (const value of [
      "acme.com",
      "ACME.COM",
      "https://www.acme.com/pricing",
      "  northwind.ai  ",
      "acme.co.uk",
      "my-brand.io",
    ]) {
      expect(isPlausibleDomain(value)).toBe(true);
    }
  });

  it("rejects the value that actually broke citation rate", () => {
    // A domain stored as "acme." matches nothing and holds citation rate at 0%,
    // which reads the same as "no assistant links you".
    expect(isPlausibleDomain("acme.")).toBe(false);
    expect(isPlausibleDomain(".com")).toBe(false);
    expect(isPlausibleDomain("acme..com")).toBe(false);
  });

  it("rejects a bare hostname with no top-level label", () => {
    expect(isPlausibleDomain("localhost")).toBe(false);
    expect(isPlausibleDomain("acme")).toBe(false);
  });

  it("rejects a numeric top-level label, so an IP address is not a brand domain", () => {
    expect(isPlausibleDomain("1.2.3.4")).toBe(false);
    expect(isPlausibleDomain("acme.123")).toBe(false);
  });

  it("rejects anything with whitespace inside it", () => {
    expect(isPlausibleDomain("acme .com")).toBe(false);
    expect(isPlausibleDomain("two domains.com")).toBe(false);
  });

  it("rejects a sentence somebody pasted in", () => {
    // Fragments of a chat message pasted into the domains field.
    expect(isPlausibleDomain("can you fix the domain")).toBe(false);
    expect(isPlausibleDomain("")).toBe(false);
    expect(isPlausibleDomain("   ")).toBe(false);
  });

  it("rejects a label that starts or ends with a hyphen", () => {
    expect(isPlausibleDomain("-acme.com")).toBe(false);
    expect(isPlausibleDomain("acme-.com")).toBe(false);
  });

  it("does not require the domain to resolve", () => {
    // A new company's domain may not resolve yet, and refusing it would be
    // worse than accepting it.
    expect(isPlausibleDomain("a-brand-launched-today.com")).toBe(true);
  });

  it("agrees with matching: anything it accepts can match its own host", () => {
    for (const value of ["acme.com", "northwind.ai", "acme.co.uk", "my-brand.io"]) {
      expect(isPlausibleDomain(value)).toBe(true);
      expect(hostMatchesDomain(normalizeDomain(value), value)).toBe(true);
    }
  });
});

describe("isCitation", () => {
  it("counts a link that matches one of the brand's domains", () => {
    expect(isCitation("https://www.acme.com/pricing", ["acme.com"])).toBe(true);
    expect(isCitation("https://blog.acme.co.uk/x", ["other.com", "acme.co.uk"])).toBe(true);
  });

  it("does not count a link to somebody else", () => {
    expect(isCitation("https://competitor.com", ["acme.com"])).toBe(false);
    // A shared .co.uk suffix must not make this a citation for acme.co.uk.
    expect(isCitation("https://someblog.co.uk", ["acme.co.uk"])).toBe(false);
  });

  it("is never a citation without a link", () => {
    // Named in prose is a mention, not a citation.
    for (const url of [null, undefined, "", "not a url"]) {
      expect(isCitation(url, ["acme.com"])).toBe(false);
    }
  });

  it("counts any attributed link for a brand with no domains", () => {
    // Newly discovered competitors arrive with no domains and are seeded from
    // these links, so dropping the link would lose the only evidence of where
    // they live.
    expect(isCitation("https://whoever.com", [])).toBe(true);
    expect(isCitation("https://whoever.com", null)).toBe(true);
    expect(isCitation("https://whoever.com", undefined)).toBe(true);
  });

  it("treats a list of blank domains as no domains", () => {
    // A domains array can hold fragments of a chat message. Whitespace entries
    // must not silently turn every link into a non-citation.
    expect(isCitation("https://whoever.com", ["", "   "])).toBe(true);
  });

  it("still requires a match once one real domain is on file", () => {
    expect(isCitation("https://whoever.com", ["", "acme.com"])).toBe(false);
    expect(isCitation("https://acme.com", ["", "acme.com"])).toBe(true);
  });
});
