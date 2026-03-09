import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobScheduler } from '../src/jobs/scheduler.js';

describe('JobScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs delayed recurring jobs immediately on start and then at the configured initial delay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T00:00:00Z'));

    const run = vi.fn(async () => {});
    const scheduler = new JobScheduler({
      info() {},
      error() {}
    });

    scheduler.start([{
      name: 'anchored-job',
      scheduleMs: 1000,
      initialDelayMs: 300,
      run
    }]);

    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(299);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(3);
  });
});
