import type { JobDefinition, JobLogger, ScheduledJob } from './types.js';

type TimerHandles = {
  interval?: NodeJS.Timeout;
  timeout?: NodeJS.Timeout;
};

export class JobScheduler {
  private readonly timers = new Map<string, TimerHandles>();

  constructor(private readonly logger: JobLogger) {}

  start(jobs: JobDefinition[]): ScheduledJob[] {
    return jobs.map((job) => this.startJob(job));
  }

  stopAll(): void {
    for (const handles of this.timers.values()) {
      if (handles.interval) {
        clearInterval(handles.interval);
      }
      if (handles.timeout) {
        clearTimeout(handles.timeout);
      }
    }

    this.timers.clear();
  }

  private startJob(job: JobDefinition): ScheduledJob {
    const run = async () => {
      try {
        await job.run({ now: new Date(), logger: this.logger });
        this.logger.info('job completed', { job: job.name });
      } catch (error) {
        this.logger.error('job failed', {
          job: job.name,
          error: error instanceof Error ? error.message : 'unknown'
        });
      }
    };

    const handles: TimerHandles = {};
    const startInterval = () => {
      handles.interval = setInterval(() => {
        void run();
      }, job.scheduleMs);
    };

    if (job.initialDelayMs !== undefined) {
      handles.timeout = setTimeout(() => {
        void run();
        startInterval();
      }, Math.max(1, Math.floor(job.initialDelayMs)));
    } else {
      startInterval();
    }

    this.timers.set(job.name, handles);
    if (job.runOnStart !== false) {
      void run();
    }

    return {
      ...job,
      stop: () => {
        const active = this.timers.get(job.name);
        if (active?.interval) {
          clearInterval(active.interval);
        }
        if (active?.timeout) {
          clearTimeout(active.timeout);
        }
        if (active) {
          this.timers.delete(job.name);
        }
      }
    };
  }
}
