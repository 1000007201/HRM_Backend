import { PgBoss } from "pg-boss";
import { env } from "../env.js";

export const PAYSLIP_GENERATE_AND_EMAIL_QUEUE = "payslip-generate-and-email";
export const PAYSLIP_BATCH_TRIGGER_QUEUE = "payslip-batch-trigger";

// pg-boss v12 moved retry/retention off the constructor and onto each
// queue (see createQueue below) — there is no longer a global default for
// this. 30 days of visibility on created/retrying jobs, 60 days before a
// completed job is hard-deleted.
const QUEUE_OPTIONS = {
  retryLimit: 3,
  retryDelay: 60,
  retentionSeconds: 30 * 24 * 60 * 60,
  deleteAfterSeconds: 60 * 24 * 60 * 60,
};

let boss: PgBoss | null = null;

export async function getQueueInstance(): Promise<PgBoss> {
  if (!boss) {
    const instance = new PgBoss({ connectionString: env.DATABASE_URL });
    instance.on("error", (error) => console.error("[pg-boss]", error));
    await instance.start();
    // createQueue is idempotent (safe on every boot) — see pg-boss's own
    // README, which calls it unconditionally before every send()/work().
    await instance.createQueue(PAYSLIP_GENERATE_AND_EMAIL_QUEUE, QUEUE_OPTIONS);
    await instance.createQueue(PAYSLIP_BATCH_TRIGGER_QUEUE, QUEUE_OPTIONS);
    boss = instance;
  }
  return boss;
}

export async function stopQueue(): Promise<void> {
  if (boss) {
    await boss.stop();
    boss = null;
  }
}
