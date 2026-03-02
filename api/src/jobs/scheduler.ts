import type { JobDefinition, JobLogger, ScheduledJob } from './types.js';

export class JobScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly logger: JobLogger) {}

  start(jobs: JobDefinition[]): ScheduledJob[] {
    return jobs.map((job) => this.startJob(job));
  }

  stopAll(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
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

    const timer = setInterval(() => {
      void run();
    }, job.scheduleMs);

    this.timers.set(job.name, timer);
    void run();

    return {
      ...job,
      stop: () => {
        const active = this.timers.get(job.name);
        if (active) {
          clearInterval(active);
          this.timers.delete(job.name);
        }
      }
    };
  }
}
