import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../core/prisma.js";
import { EmployeeRole } from "../../generated/prisma/client.js";
import { ok } from "../../core/response.js";
import { createSalaryStructure, getActiveSalaryStructure, listSalaryStructureHistory } from "./salaryStructures.service.js";

const ADMIN_ROLES = [EmployeeRole.ADMIN];

const employeeIdParamSchema = z.object({ employeeId: z.string().min(1) });

const createSalaryStructureSchema = z.object({
  annualCtc: z.number().positive(),
  effectiveFrom: z.coerce.date(),
  components: z
    .array(
      z.object({
        componentId: z.string().min(1),
        monthlyAmount: z.number().min(0),
        annualAmount: z.number().min(0),
      }),
    )
    .min(1, "At least one component is required"),
});

export const salaryStructureRoutes = async (app: FastifyInstance) => {
  app.post(
    "/api/employees/:employeeId/salary-structure",
    { preHandler: app.requireRole(ADMIN_ROLES) },
    async (request, reply) => {
      const { organizationId } = request.auth;
      const { employeeId } = employeeIdParamSchema.parse(request.params);
      const body = createSalaryStructureSchema.parse(request.body);

      const structure = await createSalaryStructure(prisma, { organizationId, employeeId, ...body });

      reply.status(201);
      return ok({ structure });
    },
  );

  app.get(
    "/api/employees/:employeeId/salary-structure",
    { preHandler: app.requireRole(ADMIN_ROLES) },
    async (request) => {
      const { organizationId } = request.auth;
      const { employeeId } = employeeIdParamSchema.parse(request.params);

      const structure = await getActiveSalaryStructure(prisma, { organizationId, employeeId });
      return ok({ structure });
    },
  );

  app.get(
    "/api/employees/:employeeId/salary-structure/history",
    { preHandler: app.requireRole(ADMIN_ROLES) },
    async (request) => {
      const { organizationId } = request.auth;
      const { employeeId } = employeeIdParamSchema.parse(request.params);

      const structures = await listSalaryStructureHistory(prisma, { organizationId, employeeId });
      return ok({ structures });
    },
  );
};
