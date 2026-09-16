import type { FastifyInstance } from "fastify";
import { env } from "../../env.js";
import { AppError } from "../../core/errors.js";
import { ok } from "../../core/response.js";
import { accrueForAllOrgs } from "./accrual.js";
import { grantAnnualForAllOrgs } from "./floaterGrant.js";

// No Better Auth session here by design — this is machine-to-machine (the
// monthly cron), gated by a shared secret instead of app.requireAuth. Kept in
// its own route file/namespace (/system/*, not /api/* or a guarded route) so
// it's obviously not part of the normal user-facing surface.
export const systemAccrualRoutes = async (app: FastifyInstance) => {
  // Runs both the monthly accrual AND the annual floater grant on every hit.
  // grantAnnualForOrg is idempotent per (employee, leaveType, year), so
  // running it on every monthly cron tick (not just once in January) is
  // harmless — it just no-ops after the first grant of the year, and still
  // covers an org whose FLOATER type or first eligible employee didn't exist
  // yet in January.
  app.post("/system/leave/accrual/run-all", async (request) => {
    if (request.headers["x-accrual-secret"] !== env.ACCRUAL_SECRET) {
      throw new AppError(401, "UNAUTHORIZED", "Unauthorized");
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const [accrualResults, grantResults] = await Promise.all([
      accrueForAllOrgs(year, month),
      grantAnnualForAllOrgs(year),
    ]);

    return ok({
      year,
      month,
      organizationsProcessed: accrualResults.length,
      results: accrualResults,
      floaterGrantResults: grantResults,
    });
  });
};
