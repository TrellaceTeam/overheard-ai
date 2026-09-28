/**
 * Deterministic ids for the demo project's runs.
 *
 * Run ids derive from the seed, so two fresh demo builds give the same story
 * the same ids, and the showcase run (the newest weekly run, which the tour
 * opens on) has an id a client can name without a lookup. Everything else in
 * the generator keeps random UUIDs: only runs are addressed from outside.
 *
 * Lives in lib/ because the browser needs it too: the tour navigates to the
 * showcase run by id. No node imports in here.
 */

/** The generator's seed. Shared with the story PRNG. */
export const DEMO_SEED = 0x51ea;

/** Weeks of invented history; week index 0 is the oldest run. */
export const DEMO_WEEKS = 26;

/** mulberry32: small, fast, and seeded, so unlike Math.random it gives the same sequence every time. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The run id for one week index: a v4-shaped UUID from a PRNG seeded per index,
 * so it is stable across builds and databases. Index DEMO_WEEKS is the
 * perception run, which sits after the weekly history.
 */
export function demoRunId(weekIndex: number): string {
  const rand = prng((DEMO_SEED ^ Math.imul(weekIndex + 1, 0x9e3779b9)) >>> 0);
  const bytes: number[] = [];
  for (let i = 0; i < 16; i += 1) {
    const byte = Math.floor(rand() * 256);
    // Byte 6 carries the version (4), byte 8 the RFC 4122 variant.
    bytes.push(i === 6 ? (byte & 0x0f) | 0x40 : i === 8 ? (byte & 0x3f) | 0x80 : byte);
  }
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The newest weekly run: the one the tour opens on. */
export function demoShowcaseRunId(): string {
  return demoRunId(DEMO_WEEKS - 1);
}
