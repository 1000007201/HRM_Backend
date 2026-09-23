import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../core/prisma.js";
import { EmployeeRole } from "../../generated/prisma/client.js";
import { ok } from "../../core/response.js";
import { getOrCreatePayrollSettings, updatePayrollSettings } from "./payrollSettings.service.js";

const ADMIN_ROLES = [EmployeeRole.ADMIN];

const updateSettingsSchema = z.object({
  pfEnabled: z.boolean().optional(),
  pfCeiling: z.boolean().optional(),
  esiEnabled: z.boolean().optional(),
  ptEnabled: z.boolean().optional(),
  ptState: z.string().min(1).nullable().optional(),
  lopBasis: z.enum(["CALENDAR_DAYS", "WORKING_DAYS"]).optional(),
});

export const payrollSettingsRoutes = async (app: FastifyInstance) => {
  app.get("/api/payroll-settings", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const settings = await getOrCreatePayrollSettings(prisma, { organizationId: request.auth.organizationId });
    return ok({ settings });
  });

  app.put("/api/payroll-settings", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const body = updateSettingsSchema.parse(request.body);
    const settings = await updatePayrollSettings(prisma, { organizationId: request.auth.organizationId, ...body });
    return ok({ settings });
  });
};
