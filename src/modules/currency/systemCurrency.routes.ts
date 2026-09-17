import type { FastifyInstance } from "fastify";
import { env } from "../../env.js";
import { prisma } from "../../core/prisma.js";
import { AppError } from "../../core/errors.js";
import { ok } from "../../core/response.js";
import { refreshRates } from "./exchangeRates.service.js";

// No Better Auth session here by design — this is machine-to-machine (the
// daily cron), gated by a shared secret instead of app.requireAuth. Same
// pattern as /system/leave/accrual/run-all (systemAccrual.routes.ts): its
// own /system/* namespace, obviously not part of the normal user-facing surface.
export const systemCurrencyRoutes = async (app: FastifyInstance) => {
  app.post("/system/currency/refresh", async (request) => {
    if (request.headers["x-currency-refresh-secret"] !== env.CURRENCY_REFRESH_SECRET) {
      throw new AppError(401, "UNAUTHORIZED", "Unauthorized");
    }

    const rates = await refreshRates(prisma);
    return ok({ ratesRefreshed: rates.length, rates });
  });
};
