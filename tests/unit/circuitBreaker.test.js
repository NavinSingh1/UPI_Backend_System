const {
  CircuitBreaker,
  CircuitOpenError,
  CircuitTimeoutError,
  STATES,
  getBreaker,
  allBreakerStates,
} = require('../../src/utils/circuitBreaker');

/** A controllable clock so state transitions can be tested without sleeping. */
const makeClock = (start = 0) => {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
};

const failing = () => Promise.reject(new Error('dependency down'));
const succeeding = () => Promise.resolve('ok');

describe('CircuitBreaker — CLOSED state', () => {
  test('passes calls through and returns their result', async () => {
    const breaker = new CircuitBreaker({ name: 'test' });
    await expect(breaker.execute(succeeding)).resolves.toBe('ok');
    expect(breaker.state).toBe(STATES.CLOSED);
  });

  test('propagates the underlying error without swallowing it', async () => {
    const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 5 });
    await expect(breaker.execute(failing)).rejects.toThrow('dependency down');
    expect(breaker.state).toBe(STATES.CLOSED); // one failure isn't enough
  });

  test('a success resets the consecutive-failure run', async () => {
    const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 3 });

    await expect(breaker.execute(failing)).rejects.toThrow();
    await expect(breaker.execute(failing)).rejects.toThrow();
    expect(breaker.failures).toBe(2);

    await breaker.execute(succeeding);
    expect(breaker.failures).toBe(0);

    // Two more failures should still not trip it, since the run restarted
    await expect(breaker.execute(failing)).rejects.toThrow();
    await expect(breaker.execute(failing)).rejects.toThrow();
    expect(breaker.state).toBe(STATES.CLOSED);
  });
});

describe('CircuitBreaker — tripping to OPEN', () => {
  test('opens after exactly failureThreshold consecutive failures', async () => {
    const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 3 });

    await expect(breaker.execute(failing)).rejects.toThrow('dependency down');
    await expect(breaker.execute(failing)).rejects.toThrow('dependency down');
    expect(breaker.state).toBe(STATES.CLOSED);

    await expect(breaker.execute(failing)).rejects.toThrow('dependency down');
    expect(breaker.state).toBe(STATES.OPEN);
  });

  test('once OPEN it fails fast without calling the dependency at all', async () => {
    const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 1 });
    await expect(breaker.execute(failing)).rejects.toThrow();
    expect(breaker.state).toBe(STATES.OPEN);

    const dependency = jest.fn(succeeding);
    await expect(breaker.execute(dependency)).rejects.toThrow(CircuitOpenError);

    // The whole point: the dependency is never touched while open
    expect(dependency).not.toHaveBeenCalled();
    expect(breaker.stats.rejected).toBe(1);
  });

  test('the rejection carries a 503 and a retry hint', async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      resetTimeoutMs: 30000,
      now: clock.now,
    });

    await expect(breaker.execute(failing)).rejects.toThrow();
    clock.advance(10000);

    const err = await breaker.execute(succeeding).catch((e) => e);
    expect(err).toBeInstanceOf(CircuitOpenError);
    expect(err.statusCode).toBe(503);
    expect(err.retryAfterMs).toBe(20000); // 30s window, 10s elapsed
  });
});

describe('CircuitBreaker — HALF_OPEN recovery', () => {
  test('moves to HALF_OPEN once the reset window elapses', async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      resetTimeoutMs: 5000,
      successThreshold: 1,
      now: clock.now,
    });

    await expect(breaker.execute(failing)).rejects.toThrow();
    expect(breaker.state).toBe(STATES.OPEN);

    // Still open just before the window closes
    clock.advance(4999);
    await expect(breaker.execute(succeeding)).rejects.toThrow(CircuitOpenError);

    clock.advance(1);
    await expect(breaker.execute(succeeding)).resolves.toBe('ok');
    expect(breaker.state).toBe(STATES.CLOSED);
  });

  test('needs successThreshold successes to fully close', async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      successThreshold: 2,
      now: clock.now,
    });

    await expect(breaker.execute(failing)).rejects.toThrow();
    clock.advance(1000);

    await breaker.execute(succeeding);
    expect(breaker.state).toBe(STATES.HALF_OPEN); // one isn't enough

    await breaker.execute(succeeding);
    expect(breaker.state).toBe(STATES.CLOSED);
  });

  test('a single failed probe reopens immediately, without re-reaching the threshold', async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 5,
      resetTimeoutMs: 1000,
      now: clock.now,
    });

    for (let i = 0; i < 5; i += 1) {
      await expect(breaker.execute(failing)).rejects.toThrow();
    }
    expect(breaker.state).toBe(STATES.OPEN);

    clock.advance(1000);
    await expect(breaker.execute(failing)).rejects.toThrow('dependency down');

    // Back to OPEN off one bad probe — the dependency is still sick
    expect(breaker.state).toBe(STATES.OPEN);
    expect(breaker.stats.opens).toBe(2);
  });

  test('allows only one concurrent probe while HALF_OPEN', async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      successThreshold: 5,
      now: clock.now,
    });

    await expect(breaker.execute(failing)).rejects.toThrow();
    clock.advance(1000);

    // Hold the first probe open, then fire a second call
    let release;
    const slow = () => new Promise((resolve) => { release = resolve; });

    const first = breaker.execute(slow);
    await expect(breaker.execute(succeeding)).rejects.toThrow(CircuitOpenError);

    release('done');
    await expect(first).resolves.toBe('done');
  });

  test('the reset window restarts from each reopen', async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      now: clock.now,
    });

    await expect(breaker.execute(failing)).rejects.toThrow();
    clock.advance(1000);
    await expect(breaker.execute(failing)).rejects.toThrow(); // failed probe -> OPEN again

    clock.advance(999);
    await expect(breaker.execute(succeeding)).rejects.toThrow(CircuitOpenError);
    clock.advance(1);
    await expect(breaker.execute(succeeding)).resolves.toBe('ok');
  });
});

describe('CircuitBreaker — timeouts', () => {
  test('a hanging call times out and counts as a failure', async () => {
    const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 1, timeoutMs: 20 });

    const hangs = () => new Promise(() => {}); // never settles
    await expect(breaker.execute(hangs)).rejects.toThrow(CircuitTimeoutError);

    expect(breaker.state).toBe(STATES.OPEN);
    expect(breaker.stats.timeouts).toBe(1);
  });

  test('a call finishing inside the timeout is unaffected', async () => {
    const breaker = new CircuitBreaker({ name: 'test', timeoutMs: 200 });
    const quick = () => new Promise((resolve) => setTimeout(() => resolve('fast'), 10));

    await expect(breaker.execute(quick)).resolves.toBe('fast');
    expect(breaker.stats.timeouts).toBe(0);
  });

  test('a synchronous throw is captured as a failure, not propagated raw', async () => {
    const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 1 });
    const throwsSync = () => {
      throw new Error('sync boom');
    };

    await expect(breaker.execute(throwsSync)).rejects.toThrow('sync boom');
    expect(breaker.state).toBe(STATES.OPEN);
  });
});

describe('CircuitBreaker — observability', () => {
  test('getState reports state, counters and retry hint', async () => {
    const breaker = new CircuitBreaker({ name: 'smtp-test', failureThreshold: 2 });

    await breaker.execute(succeeding);
    await expect(breaker.execute(failing)).rejects.toThrow();

    const state = breaker.getState();
    expect(state.name).toBe('smtp-test');
    expect(state.state).toBe(STATES.CLOSED);
    expect(state.consecutiveFailures).toBe(1);
    expect(state.failureThreshold).toBe(2);
    expect(state.stats).toMatchObject({ calls: 2, successes: 1, failures: 1 });
  });

  test('fires onStateChange for every transition', async () => {
    const clock = makeClock();
    const transitions = [];
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      resetTimeoutMs: 100,
      successThreshold: 1,
      now: clock.now,
      onStateChange: ({ from, to }) => transitions.push(`${from}->${to}`),
    });

    await expect(breaker.execute(failing)).rejects.toThrow();
    clock.advance(100);
    await breaker.execute(succeeding);

    expect(transitions).toEqual(['CLOSED->OPEN', 'OPEN->HALF_OPEN', 'HALF_OPEN->CLOSED']);
  });

  test('reset() forces the breaker closed', async () => {
    const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 1 });
    await expect(breaker.execute(failing)).rejects.toThrow();
    expect(breaker.state).toBe(STATES.OPEN);

    breaker.reset();
    expect(breaker.state).toBe(STATES.CLOSED);
    await expect(breaker.execute(succeeding)).resolves.toBe('ok');
  });
});

describe('breaker registry', () => {
  test('getBreaker returns the same instance for a name', () => {
    const a = getBreaker('registry-test', { failureThreshold: 9 });
    const b = getBreaker('registry-test');
    expect(a).toBe(b);
    expect(b.failureThreshold).toBe(9);
  });

  test('allBreakerStates includes every registered breaker', () => {
    getBreaker('registry-test-2');
    const names = allBreakerStates().map((s) => s.name);
    expect(names).toContain('registry-test');
    expect(names).toContain('registry-test-2');
  });
});
