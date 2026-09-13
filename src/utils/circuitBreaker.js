/**
 * Circuit Breaker.
 *
 * Wraps calls to an unreliable dependency (SMTP, a third-party API) so that
 * when it starts failing we stop calling it instead of piling up requests
 * that each wait for a timeout. Three states:
 *
 *   CLOSED     — normal. Failures are counted; `failureThreshold` consecutive
 *                failures trips the breaker to OPEN.
 *   OPEN       — fail fast. Every call is rejected immediately without
 *                touching the dependency, until `resetTimeoutMs` elapses.
 *   HALF_OPEN  — probing. A single call is let through to test recovery.
 *                `successThreshold` successes close the breaker; ONE failure
 *                sends it straight back to OPEN (no second chance — a failed
 *                probe is evidence the dependency is still sick).
 *
 * `now` is injectable so the state machine can be unit-tested deterministically
 * without sleeping — see tests/unit/circuitBreaker.test.js.
 */

const STATES = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

class CircuitOpenError extends Error {
  constructor(name, retryAfterMs) {
    super(`Circuit "${name}" is open — dependency is unavailable, failing fast`);
    this.name = 'CircuitOpenError';
    this.statusCode = 503; // errorHandler maps this straight through
    this.circuit = name;
    this.retryAfterMs = retryAfterMs;
  }
}

class CircuitTimeoutError extends Error {
  constructor(name, timeoutMs) {
    super(`Circuit "${name}" call exceeded ${timeoutMs}ms`);
    this.name = 'CircuitTimeoutError';
    this.statusCode = 504;
    this.circuit = name;
  }
}

class CircuitBreaker {
  constructor({
    name = 'unnamed',
    failureThreshold = 5,
    resetTimeoutMs = 30000,
    successThreshold = 2,
    timeoutMs = 10000,
    now = Date.now,
    onStateChange,
  } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.successThreshold = successThreshold;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.onStateChange = onStateChange;

    this.state = STATES.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.openedAt = null;
    this.probeInFlight = false;

    // Cumulative counters, useful for /metrics
    this.stats = { calls: 0, successes: 0, failures: 0, rejected: 0, timeouts: 0, opens: 0 };
  }

  _transition(next) {
    if (this.state === next) return;
    const previous = this.state;
    this.state = next;

    if (next === STATES.OPEN) {
      this.openedAt = this.now();
      this.stats.opens += 1;
      this.probeInFlight = false;
    }
    if (next === STATES.CLOSED) {
      this.failures = 0;
      this.successes = 0;
      this.openedAt = null;
      this.probeInFlight = false;
    }
    if (next === STATES.HALF_OPEN) {
      this.successes = 0;
      this.probeInFlight = false;
    }

    this.onStateChange?.({ circuit: this.name, from: previous, to: next });
  }

  /** True once the open period has elapsed and we're due to probe. */
  _readyToProbe() {
    return this.state === STATES.OPEN && this.now() - this.openedAt >= this.resetTimeoutMs;
  }

  _remainingOpenMs() {
    if (this.state !== STATES.OPEN) return 0;
    return Math.max(this.resetTimeoutMs - (this.now() - this.openedAt), 0);
  }

  /** Races `promise` against the configured per-call timeout without leaking a timer. */
  _withTimeout(promise) {
    if (!this.timeoutMs) return promise;

    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new CircuitTimeoutError(this.name, this.timeoutMs)), this.timeoutMs);
      // Don't hold the event loop open just for this timer
      timer.unref?.();
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  _recordSuccess() {
    this.stats.successes += 1;

    if (this.state === STATES.HALF_OPEN) {
      this.successes += 1;
      this.probeInFlight = false;
      if (this.successes >= this.successThreshold) this._transition(STATES.CLOSED);
      return;
    }

    // A success in CLOSED resets the consecutive-failure run
    this.failures = 0;
  }

  _recordFailure() {
    this.stats.failures += 1;

    if (this.state === STATES.HALF_OPEN) {
      // The dependency is still broken — reopen immediately
      this.probeInFlight = false;
      this._transition(STATES.OPEN);
      return;
    }

    this.failures += 1;
    if (this.failures >= this.failureThreshold) this._transition(STATES.OPEN);
  }

  /**
   * Runs `fn` under the breaker.
   * @throws {CircuitOpenError} immediately when the circuit is open
   * @throws {CircuitTimeoutError} when the call exceeds timeoutMs
   */
  async execute(fn) {
    if (this._readyToProbe()) this._transition(STATES.HALF_OPEN);

    if (this.state === STATES.OPEN) {
      this.stats.rejected += 1;
      throw new CircuitOpenError(this.name, this._remainingOpenMs());
    }

    // In HALF_OPEN, allow exactly one probe at a time so a burst of traffic
    // doesn't hammer a dependency that may still be down.
    if (this.state === STATES.HALF_OPEN) {
      if (this.probeInFlight) {
        this.stats.rejected += 1;
        throw new CircuitOpenError(this.name, 0);
      }
      this.probeInFlight = true;
    }

    this.stats.calls += 1;

    try {
      const result = await this._withTimeout(Promise.resolve().then(fn));
      this._recordSuccess();
      return result;
    } catch (err) {
      if (err instanceof CircuitTimeoutError) this.stats.timeouts += 1;
      this._recordFailure();
      throw err;
    }
  }

  /** Snapshot for /health and /metrics. */
  getState() {
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.failures,
      failureThreshold: this.failureThreshold,
      retryAfterMs: this._remainingOpenMs(),
      stats: { ...this.stats },
    };
  }

  /** Test/ops escape hatch. */
  reset() {
    this._transition(STATES.CLOSED);
  }
}

/** Registry so /health can report every breaker without importing each one. */
const registry = new Map();

const getBreaker = (name, options = {}) => {
  if (!registry.has(name)) {
    registry.set(name, new CircuitBreaker({ name, ...options }));
  }
  return registry.get(name);
};

const allBreakerStates = () => [...registry.values()].map((breaker) => breaker.getState());

module.exports = {
  CircuitBreaker,
  CircuitOpenError,
  CircuitTimeoutError,
  STATES,
  getBreaker,
  allBreakerStates,
};
