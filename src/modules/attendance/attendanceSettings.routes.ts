import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../core/prisma.js";
import { EmployeeRole } from "../../generated/prisma/client.js";
import { ok } from "../../core/response.js";
import { getAttendanceSettings, updateAttendanceSettings } from "./attendanceSettings.service.js";

const ADMIN_ROLES = [EmployeeRole.ADMIN];

const updateSchema = z
  .object({
    fullDayMinutes: z.number().int().positive().optional(),
    halfDayMinutes: z.number().int().positive().optional(),
    weekOffDays: z
      .array(z.number().int().min(0).max(6))
      .max(7)
      .refine((days) => new Set(days).size === days.length, { message: "weekOffDays must not contain duplicates" })
      .optional(),
    allowRegularization: z.boolean().optional(),
    maxRegularizationsPerMonth: z.number().int().positive().nullable().optional(),
    regularizationWindowDays: z.number().int().positive().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" });

export const attendanceSettingsRoutes = async (app: FastifyInstance) => {
  app.get("/attendance/settings", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId } = request.auth;
    const settings = await getAttendanceSettings(prisma, organizationId);
    return ok({ settings });
  });

  app.patch("/attendance/settings", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const body = updateSchema.parse(request.body);
    const settings = await updateAttendanceSettings(prisma, organizationId, body);
    return ok({ settings });
  });
};
