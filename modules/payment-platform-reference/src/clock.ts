/**
 * Every time in this module is supplied, never read from the host.
 *
 * There is no Date.now() and no new Date() anywhere in src/. A scenario that
 * needs time to pass says so. That is what makes `make report` byte-identical
 * across runs, and it is also what lets the stale-read check below be a fact
 * rather than a race.
 */

/** Fixed synthetic epoch: 2026-01-01T00:00:00Z, in milliseconds. */
export const EPOCH_MS = 1767225600000;

export interface Clock {
  now(): number;
  advance(ms: number): void;
}

export function makeClock(startMs: number = EPOCH_MS): Clock {
  let t = startMs;
  return {
    now(): number {
      // Each read advances by one millisecond so that two events recorded in
      // the same logical step still order deterministically.
      t += 1;
      return t;
    },
    advance(ms: number): void {
      t += ms;
    },
  };
}

/** Render a synthetic timestamp without touching the host locale. */
export function isoOf(ms: number): string {
  const total = ms - EPOCH_MS;
  const msPart = total % 1000;
  const sec = Math.floor(total / 1000) % 60;
  const min = Math.floor(total / 60000) % 60;
  const hr = Math.floor(total / 3600000) % 24;
  const day = Math.floor(total / 86400000);
  const p = (n: number, w: number) => String(n).padStart(w, '0');
  return `T+${p(day, 2)}d${p(hr, 2)}:${p(min, 2)}:${p(sec, 2)}.${p(msPart, 3)}`;
}
