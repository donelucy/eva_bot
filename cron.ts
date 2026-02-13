import cron from "node-cron";
import { getCronJobs, saveCronJob } from "../memory/db.js";
import type { AgentLoop } from "../agent/loop.js";
import type { CronJob } from "../types.js";
import { logger } from "../utils/logger.js";

type SendFn = (userId: string, channel: string, text: string) => Promise<void>;

export class Scheduler {
  private tasks = new Map<string, cron.ScheduledTask>();

  constructor(
    private agent: AgentLoop,
    private send: SendFn
  ) {}

  /**
   * Load all enabled cron jobs from DB and schedule them
   */
  start(): void {
    const jobs = getCronJobs();
    for (const job of jobs) {
      this.schedule(job.id);
    }
    logger.info(`[Scheduler] Started ${jobs.length} cron job(s)`);
  }

  /**
   * Stop all scheduled tasks
   */
  stop(): void {
    for (const [, task] of this.tasks) {
      task.stop();
    }
    this.tasks.clear();
    logger.info("[Scheduler] All tasks stopped");
  }

  /**
   * Schedule a single job by ID
   */
  schedule(jobId: string): void {
    const jobs = getCronJobs();
    const job = jobs.find((j: CronJob) => j.id === jobId);
    if (!job || !job.enabled) return;

    if (!cron.validate(job.schedule)) {
      logger.warn(`[Scheduler] Invalid cron expression for job "${job.name}": ${job.schedule}`);
      return;
    }

    // Cancel existing if rescheduling
    this.cancel(jobId);

    const scheduleOptions: cron.ScheduleOptions = {
      timezone: job.timezone ?? "UTC",
    };

    const task = cron.schedule(job.schedule, async () => {
      logger.info(`[Scheduler] Running job: ${job.name}`);
      try {
        const response = await this.agent.processCron(job);
        await this.send(job.targetUserId, job.targetChannel, response);

        // Update last run
        job.lastRun = Date.now();
        saveCronJob(job);
      } catch (err) {
        logger.error(`[Scheduler] Job "${job.name}" failed:`, err);
      }
    }, scheduleOptions);

    this.tasks.set(jobId, task);
    const tz = job.timezone ? ` [${job.timezone}]` : " [UTC]";
    logger.info(`[Scheduler] Scheduled: "${job.name}" (${job.schedule})${tz}`);
  }

  /**
   * Cancel and remove a scheduled task
   */
  cancel(jobId: string): void {
    const task = this.tasks.get(jobId);
    if (task) {
      task.stop();
      this.tasks.delete(jobId);
    }
  }

  /**
   * Re-sync with database — picks up new jobs and removes deleted ones
   */
  sync(): void {
    const dbJobs = getCronJobs();
    const dbJobIds = new Set(dbJobs.map((j: CronJob) => j.id));

    // Cancel jobs that were deleted from DB
    for (const [id] of this.tasks) {
      if (!dbJobIds.has(id)) {
        this.cancel(id);
      }
    }

    // Schedule new/updated jobs
    for (const job of dbJobs) {
      if (!this.tasks.has(job.id)) {
        this.schedule(job.id);
      }
    }
  }
}
