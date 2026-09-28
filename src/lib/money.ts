/**
 * Spend is often fractions of a cent, so two decimals would read as zero.
 * Shared by the run screen's spend line and the summary cards' cost previews,
 * which must not drift apart in how they round.
 */
export function money(usd: number): string {
  if (usd === 0) return "$0.00";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
