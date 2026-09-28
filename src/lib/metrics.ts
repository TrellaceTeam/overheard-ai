export type MetricRow = {
  id: string;
  run_id: string;
  brand_id: string | null;
  model_id: string | null;
  prompt_id: string | null;
  answers: number;
  mentions: number;
  ranked: number;
  citations: number;
  top_pick_share: number | null;
  top3_rate: number | null;
  created_at: string;
};

export type Agg = {
  answers: number;
  mentions: number;
  ranked: number;
  citations: number;
  mention_rate: number | null;
  rank_rate: number | null;
  citation_rate: number | null;
  /** One of the three headline rates, with mention_rate and citation_rate. */
  top3_rate: number | null;
  top_pick_share: number | null;
  share_of_voice: number | null;
};

const div = (a: number, b: number) => (b > 0 ? a / b : null);

/**
 * Aggregate metric rows for one brand.
 *
 * `allRows` must be every row in the scope being viewed (all brands), because
 * a brand only has rows for the model/prompt scopes where it was actually
 * observed. Using the brand's own rows as the denominator would count only the
 * answers that mentioned it and report a 100% mention rate for everyone.
 */
export function aggregate(rows: MetricRow[], allRows: MetricRow[] = rows): Agg {
  const answers = sumAnswers(allRows);
  const mentions = rows.reduce((n, r) => n + r.mentions, 0);
  const ranked = rows.reduce((n, r) => n + r.ranked, 0);
  const citations = rows.reduce((n, r) => n + r.citations, 0);
  // Rate times that scope's own answers recovers the count, and counts are what
  // has to be summed: averaging the per-scope rates would weight a one-answer
  // scope the same as a fifty-answer one. Costs a little precision, since the
  // stored rates are rounded to four places.
  const tops = rows.reduce((n, r) => n + Number(r.top_pick_share ?? 0) * r.answers, 0);
  const top3 = rows.reduce((n, r) => n + Number(r.top3_rate ?? 0) * r.answers, 0);
  const allMentions = allRows.reduce((n, r) => n + r.mentions, 0);

  return {
    answers,
    mentions,
    ranked,
    citations,
    mention_rate: div(mentions, answers),
    rank_rate: div(ranked, answers),
    citation_rate: div(citations, answers),
    top3_rate: div(top3, answers),
    top_pick_share: div(tops, answers),
    share_of_voice: div(mentions, allMentions),
  };
}

/**
 * One brand's figures within `rows`, which must be every row in the scope being
 * viewed. An undefined brand, one not loaded yet, gets zero mentions over the
 * same answers.
 */
export function aggregateBrand(rows: MetricRow[], brandId: string | undefined): Agg {
  return aggregate(
    rows.filter((row) => row.brand_id === brandId),
    rows,
  );
}

/**
 * Answers are duplicated across brands in a scope, so count them once per
 * (run, model, prompt) scope instead of summing every brand row.
 */
export function sumAnswers(rows: MetricRow[]) {
  const seen = new Map<string, number>();
  for (const row of rows) {
    seen.set(`${row.run_id}|${row.model_id}|${row.prompt_id}`, row.answers);
  }
  return [...seen.values()].reduce((a, b) => a + b, 0);
}

export function groupBy<T>(rows: T[], key: (row: T) => string) {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}
