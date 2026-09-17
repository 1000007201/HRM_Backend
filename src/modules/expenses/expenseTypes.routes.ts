import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../core/prisma.js";
import { EmployeeRole } from "../../generated/prisma/client.js";
import { AppError } from "../../core/errors.js";
import { ok } from "../../core/response.js";

const ADMIN_ROLES = [EmployeeRole.ADMIN];

const idParamSchema = z.object({ id: z.string().min(1) });

const createExpenseTypeSchema = z.object({
  name: z.string().trim().min(1).max(200),
});

const updateExpenseTypeSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
});

export const expenseTypeRoutes = async (app: FastifyInstance) => {
  // Readable by any org member — the expense submission form needs the list
  // to populate its category dropdown.
  app.get("/expense-types", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId } = request.auth;

    const expenseTypes = await prisma.expenseType.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
    });

    return ok({ expenseTypes });
  });

  app.post("/expense-types", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const { organizationId } = request.auth;
    const { name } = createExpenseTypeSchema.parse(request.body);

    // Duplicate name in-org is caught by the organizationId_name unique
    // constraint and mapped to 409 CONFLICT centrally — no pre-check needed.
    const expenseType = await prisma.expenseType.create({ data: { organizationId, name } });

    reply.status(201);
    return ok({ expenseType });
  });

  app.patch("/expense-types/:id", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { id } = idParamSchema.parse(request.params);
    const body = updateExpenseTypeSchema.parse(request.body);

    const existing = await prisma.expenseType.findFirst({ where: { id, organizationId } });
    if (!existing) {
      throw new AppError(404, "NOT_FOUND", "Expense type not found");
    }

    const expenseType = await prisma.expenseType.update({ where: { id }, data: body });
    return ok({ expenseType });
  });

  app.delete("/expense-types/:id", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { id } = idParamSchema.parse(request.params);

    const existing = await prisma.expenseType.findFirst({ where: { id, organizationId } });
    if (!existing) {
      throw new AppError(404, "NOT_FOUND", "Expense type not found");
    }

    const expenseRequestCount = await prisma.expenseRequest.count({ where: { expenseTypeId: id } });
    if (expenseRequestCount > 0) {
      throw new AppError(409, "CONFLICT", "Cannot delete an expense type that expense requests still reference");
    }

    await prisma.expenseType.delete({ where: { id } });
    return ok({ id });
  });
};
