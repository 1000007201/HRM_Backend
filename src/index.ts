import { env } from "./env.js";
import { buildApp } from "./server.js";
import { prisma } from "./core/prisma.js";
import { startAccrualScheduler } from "./modules/leave/accrualScheduler.js";
import { startCurrencyScheduler } from "./modules/currency/currencyScheduler.js";
import { getQueueInstance, stopQueue } from "./lib/queue.js";
import { registerPayslipWorkers } from "./modules/payroll/payslip-worker.js";

const app = buildApp();

const start = async () => {
  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Started after the server is listening, not before — a slow queue
  // migration/start() shouldn't delay the API coming up. Workers run inside
  // this same process (see src/lib/queue.ts) rather than a separate one,
  // fine at this app's scale (SME orgs, well under a thousand employees).
  const boss = await getQueueInstance();
  registerPayslipWorkers(boss);
};

void start();

const stopAccrualScheduler = startAccrualScheduler(app.log);
const stopCurrencyScheduler = startCurrencyScheduler(app.log);

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down...`);
  stopAccrualScheduler();
  stopCurrencyScheduler();
  await stopQueue();
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
