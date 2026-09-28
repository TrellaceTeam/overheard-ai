# ADR 0005: Self-referenced prompts never count in statistics

Status: accepted 2026-09-24.

## Decision

Answers to a self-referenced prompt (one whose text names the own brand or one of its variants)
are kept, shown, and still used to discover competitors, but never count in any statistic
(mention rate, citation rate, top-3 rate, rank, share of voice), neither for the own brand nor
for competitors. Self-referenced prompts don't count towards statistics, to avoid inflating
results artificially: an answer to "Is Acme a good option?" almost always mentions Acme, and any
competitors it lists appear only because the question was about Acme.

The rule is applied by the server's metric queries, using the brand's current name and variants,
so editing a variant reclassifies past runs too. There is no switch to include them.

## Considered options

- A dashboard toggle: a returning user finds their starter prompts' data hidden, and every
  screen has to honour the toggle or two screens show different numbers.
- Excluding only the own brand's numbers: an unfair comparison, since competitors would still
  collect mentions prompted solely by naming the own brand.
- Deciding once when a run is finalised: past runs would not reflect later additions to brand
  variants.
