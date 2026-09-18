import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../core/prisma.js";
import { CalcType, ComponentType, EmployeeRole } from "../../generated/prisma/client.js";
import { AppError } from "../../core/errors.js";
import { ok } from "../../core/response.js";
import { createSalaryComponent, deactivateSalaryComponent, updateSalaryComponent } from "./salaryComponents.service.js";

const ADMIN_ROLES = [EmployeeRole.ADMIN];

const idParamSchema = z.object({ id: z.string().min(1) });

const codeSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^[A-Z0-9_]+$/, "Use uppercase letters, numbers, and underscores only");

const createSalaryComponentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  code: codeSchema,
  componentType: z.enum(ComponentType),
  calcType: z.enum(CalcType),
  fixedAmount: z.number().positive().optional(),
  percentage: z.number().positive().max(100).optional(),
  baseComponentId: z.string().min(1).optional(),
  sequence: z.number().int().positive(),
});

// PUT is a partial update in practice (rename without resending calc
// fields, toggle isActive alone, ...) despite the verb — matches this
// codebase's other admin-managed-list endpoints (Department, ExpenseType use
// PATCH for the same shape). `.nullable()` on the calc fields lets a caller
// explicitly clear one when switching calcType (e.g. FIXED -> BALANCE).
const updateSalaryComponentSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  code: codeSchema.optional(),
  componentType: z.enum(ComponentType).optional(),
  calcType: z.enum(CalcType).optional(),
  fixedAmount: z.number().positive().nullable().optional(),
  percentage: z.number().positive().max(100).nullable().optional(),
  baseComponentId: z.string().min(1).nullable().optional(),
  sequence: z.number().int().positive().optional(),
  isActive: z.boolean().optional(),
});

export const salaryComponentRoutes = async (app: FastifyInstance) => {
  app.post("/api/salary-components", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const { organizationId } = request.auth;
    const body = createSalaryComponentSchema.parse(request.body);

    const salaryComponent = await createSalaryComponent(prisma, { organizationId, ...body });

    reply.status(201);
    return ok({ salaryComponent });
  });

  app.get("/api/salary-components", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;

    const salaryComponents = await prisma.salaryComponent.findMany({
      where: { organizationId },
      orderBy: { sequence: "asc" },
    });

    return ok({ salaryComponents });
  });

  app.get("/api/salary-components/:id", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { id } = idParamSchema.parse(request.params);

    const salaryComponent = await prisma.salaryComponent.findFirst({ where: { id, organizationId } });
    if (!salaryComponent) {
      throw new AppError(404, "NOT_FOUND", "Salary component not found");
    }

    return ok({ salaryComponent });
  });

  app.put("/api/salary-components/:id", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { id } = idParamSchema.parse(request.params);
    const input = updateSalaryComponentSchema.parse(request.body);

    const salaryComponent = await updateSalaryComponent(prisma, { id, organizationId, input });
    return ok({ salaryComponent });
  });

  app.delete("/api/salary-components/:id", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { id } = idParamSchema.parse(request.params);

    const salaryComponent = await deactivateSalaryComponent(prisma, { id, organizationId });
    return ok({ salaryComponent });
  });
};
