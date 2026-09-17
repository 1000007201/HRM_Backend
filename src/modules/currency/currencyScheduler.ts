import type { FastifyBaseLogger } from "fastify";
import { prisma } from "../../core/prisma.js";
import { refreshRates } from "./exchangeRates.service.js";

// ponytail: a daily poll instead of a precise "run right after ECB updates
// at ~16:00 CET" cron — refreshRates upserts on (currency, rateDate), so
// polling more or less often never duplicates a day's rate, it only changes
// how many hours late today's rate is picked up. Upgrade to node-cron (or
// the existing /system/currency/refresh + external scheduler) if same-day
// freshness right after the ECB publish time ever matters.
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const runDailyRefresh = async (log: FastifyBaseLogger) => {
  try {
    const rates = await refreshRates(prisma);
    log.info(`[currencyScheduler] refreshed ${rates.length} exchange rate(s)`);
  } catch (err) {
    log.error(err, "[currencyScheduler] daily currency refresh failed");
  }
};

// Runs once on boot — so rates exist right after setup without waiting for
// the first cron tick — then once a day. Call the returned function on
// shutdown to stop the timer.
export const startCurrencyScheduler = (log: FastifyBaseLogger): (() => void) => {
  void runDailyRefresh(log);
  const interval = setInterval(() => void runDailyRefresh(log), CHECK_INTERVAL_MS);
  return () => clearInterval(interval);
};
