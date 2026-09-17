import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../core/prisma.js";
import { EmployeeRole } from "../../generated/prisma/client.js";
import { ok } from "../../core/response.js";
import { currencyCodeSchema, SUPPORTED_CURRENCIES } from "./currencies.js";
import { getInrRate, refreshRates } from "./exchangeRates.service.js";

const rateQuerySchema = z.object({ currency: currencyCodeSchema });

export const currencyRoutes = async (app: FastifyInstance) => {
  // Readable by any org member — the expense submission form needs this to
  // populate its currency dropdown.
  app.get("/currencies", { preHandler: app.requireAuth }, async () => {
    return ok({ currencies: SUPPORTED_CURRENCIES });
  });

  // Read-only, cache-first (see getInrRate) — lets the raise-expense form
  // show a live "≈ ₹X,XXX" preview without creating anything. The preview is
  // informational only: POST /expenses independently calls convertToInr and
  // freezes its own rate at submission time, so a rate change between this
  // call and the actual submit is never a correctness issue, only a stale
  // preview for a few seconds.
  app.get("/currencies/rate", { preHandler: app.requireAuth }, async (request) => {
    const { currency } = rateQuerySchema.parse(request.query);
    const { inrPerUnit, rateDate } = await getInrRate(prisma, currency);
    return ok({ currency, inrPerUnit, rateDate });
  });

  // Manual trigger for an ADMIN (e.g. "the rate looks stale, refresh now").
  // Refreshes the one GLOBAL ExchangeRate cache, not anything org-scoped —
  // the ADMIN gate here is just "who's allowed to press this button", same
  // spirit as /admin/leave/accrual/run.
  app.post("/admin/currency/refresh", { preHandler: app.requireRole([EmployeeRole.ADMIN]) }, async () => {
    const rates = await refreshRates(prisma);
    return ok({ ratesRefreshed: rates.length, rates });
  });
};
