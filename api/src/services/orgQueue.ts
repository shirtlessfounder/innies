import { AppError } from '../utils/errors.js';

interface PendingTask<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  createdAtMs: number;
}

interface OrgQueueState {
  running: number;
  pending: PendingTask<unknown>[];
}

export class OrgQueueManager {
  private readonly states = new Map<string, OrgQueueState>();

  constructor(
    private readonly maxPending: number,
    private readonly maxConcurrent: number,
    private readonly waitTimeoutMs: number,
  ) {}

  async run<T>(orgId: string, task: () => Promise<T>): Promise<T> {
    const state = this.getOrCreate(orgId);
    if (state.pending.length >= this.maxPending) {
      throw new AppError('capacity_unavailable', 429, 'Queue is full for org', { orgId });
    }

    return await new Promise<T>((resolve, reject) => {
      const entry: PendingTask<T> = {
        run: task,
        resolve,
        reject,
        createdAtMs: Date.now(),
      };

      state.pending.push(entry as PendingTask<unknown>);
      this.drain(orgId);
    });
  }

  snapshot(): Record<string, { running: number; pending: number }> {
    const result: Record<string, { running: number; pending: number }> = {};
    for (const [orgId, state] of this.states.entries()) {
      result[orgId] = { running: state.running, pending: state.pending.length };
    }
    return result;
  }

  private getOrCreate(orgId: string): OrgQueueState {
    const existing = this.states.get(orgId);
    if (existing) return existing;
    const next: OrgQueueState = { running: 0, pending: [] };
    this.states.set(orgId, next);
    return next;
  }

  private drain(orgId: string): void {
    const state = this.getOrCreate(orgId);
    while (state.running < this.maxConcurrent && state.pending.length > 0) {
      const next = state.pending.shift();
      if (!next) return;

      const waited = Date.now() - next.createdAtMs;
      if (waited > this.waitTimeoutMs) {
        next.reject(new AppError('capacity_unavailable', 429, 'Queue wait timeout exceeded', { orgId }));
        continue;
      }

      state.running += 1;
      next.run()
        .then(next.resolve)
        .catch(next.reject)
        .finally(() => {
          state.running -= 1;
          this.drain(orgId);
        });
    }
  }
}
