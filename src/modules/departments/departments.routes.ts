import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../core/prisma.js";
import { EmployeeRole } from "../../generated/prisma/client.js";
import { AppError } from "../../core/errors.js";
import { ok } from "../../core/response.js";

const ADMIN_ROLES = [EmployeeRole.ADMIN];

const idParamSchema = z.object({ id: z.string().min(1) });

const createDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(200),
});

const updateDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
});

export const departmentRoutes = async (app: FastifyInstance) => {
  // Readable by any org member — the employee create/edit form needs the
  // list to populate its department dropdown.
  app.get("/api/departments", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId } = request.auth;

    const departments = await prisma.department.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
    });

    return ok({ departments });
  });

  app.post("/api/departments", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const { organizationId } = request.auth;
    const { name } = createDepartmentSchema.parse(request.body);

    // Duplicate name in-org is caught by the organizationId_name unique
    // constraint and mapped to 409 CONFLICT centrally — no pre-check needed.
    const department = await prisma.department.create({ data: { organizationId, name } });

    reply.status(201);
    return ok({ department });
  });

  app.patch("/api/departments/:id", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { id } = idParamSchema.parse(request.params);
    const body = updateDepartmentSchema.parse(request.body);

    const existing = await prisma.department.findFirst({ where: { id, organizationId } });
    if (!existing) {
      throw new AppError(404, "NOT_FOUND", "Department not found");
    }

    const department = await prisma.department.update({ where: { id }, data: body });
    return ok({ department });
  });

  app.delete("/api/departments/:id", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { id } = idParamSchema.parse(request.params);

    const existing = await prisma.department.findFirst({ where: { id, organizationId } });
    if (!existing) {
      throw new AppError(404, "NOT_FOUND", "Department not found");
    }

    const employeeCount = await prisma.employee.count({ where: { departmentId: id } });
    if (employeeCount > 0) {
      throw new AppError(409, "CONFLICT", "Cannot delete a department that employees are still assigned to");
    }

    await prisma.department.delete({ where: { id } });
    return ok({ id });
  });
};
