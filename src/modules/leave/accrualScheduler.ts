import type { FastifyBaseLogger } from "fastify";
import { accrueForAllOrgs } from "./accrual.js";

// ponytail: a daily poll instead of a precise cron trigger — accrueForOrg is
// idempotent per (employee, leaveType, year, month) via lastAccruedMonth, so
// polling more or less often never double-credits, it only changes how many
// hours late a missed month-start catches up. Upgrade to node-cron (or the
// existing /system/leave/accrual/run-all + external scheduler) if crediting
// exactly on the 1st ever matters.
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const runAccrualForCurrentMonth = async (log: FastifyBaseLogger) => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  try {
    const results = await accrueForAllOrgs(year, month);
    const balancesCredited = results.reduce((sum, result) => sum + result.balancesCredited, 0);
    if (balancesCredited > 0) {
      log.info({ year, month, results }, `[accrualScheduler] credited ${balancesCredited} leave balance(s)`);
    }
  } catch (err) {
    log.error(err, "[accrualScheduler] monthly accrual run failed");
  }
};

// Runs once on boot — so a server that was down when the month rolled over
// catches up as soon as it's back — then once a day. Call the returned
// function on shutdown to stop the timer.
export const startAccrualScheduler = (log: FastifyBaseLogger): (() => void) => {
  void runAccrualForCurrentMonth(log);
  const interval = setInterval(() => void runAccrualForCurrentMonth(log), CHECK_INTERVAL_MS);
  return () => clearInterval(interval);
};
