export type JobRunContext = {
  now: Date;
  logger: JobLogger;
};

export type JobLogger = {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

export type JobDefinition = {
  name: string;
  scheduleMs: number;
  run(ctx: JobRunContext): Promise<void>;
};

export type ScheduledJob = JobDefinition & {
  stop(): void;
};
