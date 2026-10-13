// Circuit state, built so that a noisy signal cannot move all the traffic.
//
// The failure this guards against is not a provider going down. It is a
// provider looking down for ninety seconds and the router moving every
// payment onto a second provider that was never sized for it.

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface HealthConfig {
  /** Consecutive failures before opening. */
  readonly openAfter: number;
  /** Consecutive successes in HALF_OPEN before closing. Hysteresis. */
  readonly closeAfter: number;
  /** How long OPEN lasts before one probe is allowed through. */
  readonly openForMs: number;
  /**
   * Observations older than this are not evidence. Without it a provider that
   * failed twice an hour ago and has been fine since still reads as failing.
   */
  readonly staleAfterMs: number;
}

export const DEFAULT_HEALTH: HealthConfig = {
  openAfter: 3,
  closeAfter: 2,
  openForMs: 30_000,
  staleAfterMs: 120_000,
};

interface Window {
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastObservationMs: number;
  openedAtMs: number | null;
  state: CircuitState;
}

export class HealthRegistry {
  readonly #windows = new Map<string, Window>();
  readonly #config: HealthConfig;
  #transitions = 0;

  constructor(config: HealthConfig = DEFAULT_HEALTH) {
    this.#config = config;
  }

  #window(provider: string): Window {
    let w = this.#windows.get(provider);
    if (w === undefined) {
      w = { consecutiveFailures: 0, consecutiveSuccesses: 0, lastObservationMs: 0, openedAtMs: null, state: "CLOSED" };
      this.#windows.set(provider, w);
    }
    return w;
  }

  /**
   * The circuit's state at an instant.
   *
   * Two things make this safe to route on. Stale observations are discarded,
   * so an old failure stops counting; and OPEN becomes HALF_OPEN on a clock
   * rather than on a request, so one probe is admitted instead of a flood.
   */
  state(provider: string, nowMs: number): CircuitState {
    const w = this.#window(provider);
    if (w.state !== "OPEN" && nowMs - w.lastObservationMs > this.#config.staleAfterMs) {
      w.consecutiveFailures = 0;
      w.consecutiveSuccesses = 0;
    }
    if (w.state === "OPEN" && w.openedAtMs !== null &&
        nowMs - w.openedAtMs >= this.#config.openForMs) {
      w.state = "HALF_OPEN";
      w.consecutiveSuccesses = 0;
      this.#transitions += 1;
    }
    return w.state;
  }

  /** True when an attempt may be made. HALF_OPEN admits probes. */
  admits(provider: string, nowMs: number): boolean {
    return this.state(provider, nowMs) !== "OPEN";
  }

  /**
   * Record what an attempt proved about the provider.
   *
   * A **decline is not a failure**. The provider answered, promptly and
   * correctly; a router that counts declines as unhealthy will open the
   * circuit on a merchant whose customers are being refused for good reasons,
   * and move that traffic somewhere it will also be refused.
   */
  record(provider: string, kind: "success" | "failure" | "neutral", nowMs: number): void {
    const w = this.#window(provider);
    this.state(provider, nowMs);
    w.lastObservationMs = nowMs;
    if (kind === "neutral") return;

    if (kind === "failure") {
      w.consecutiveFailures += 1;
      w.consecutiveSuccesses = 0;
      if (w.state === "HALF_OPEN" ||
          (w.state === "CLOSED" && w.consecutiveFailures >= this.#config.openAfter)) {
        // Reached only from HALF_OPEN or CLOSED, so this is always a transition.
        this.#transitions += 1;
        w.state = "OPEN";
        w.openedAtMs = nowMs;
      }
      return;
    }

    w.consecutiveSuccesses += 1;
    w.consecutiveFailures = 0;
    if (w.state === "HALF_OPEN" && w.consecutiveSuccesses >= this.#config.closeAfter) {
      w.state = "CLOSED";
      w.openedAtMs = null;
      this.#transitions += 1;
    }
  }

  /** State changes so far. A flapping signal shows up here as a large number. */
  get transitions(): number {
    return this.#transitions;
  }

  snapshot(nowMs: number): Record<string, CircuitState> {
    const out: Record<string, CircuitState> = {};
    for (const p of this.#windows.keys()) out[p] = this.state(p, nowMs);
    return out;
  }
}
