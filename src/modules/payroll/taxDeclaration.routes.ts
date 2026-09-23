import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../core/prisma.js";
import { ok } from "../../core/response.js";
import { currentFinancialYear, getTaxDeclaration, upsertTaxDeclaration } from "./taxDeclaration.service.js";

const financialYearSchema = z.string().regex(/^\d{4}-\d{4}$/, "financialYear must look like 2026-2027");
const employeeIdParamSchema = z.object({ employeeId: z.string().min(1) });
const fyQuerySchema = z.object({ fy: financialYearSchema.optional() });

const upsertSchema = z.object({
  financialYear: financialYearSchema.optional(),
  regime: z.enum(["OLD", "NEW"]),
  previousEmployerIncome: z.number().min(0).optional(),
  previousEmployerTds: z.number().min(0).optional(),
  section80C: z.number().min(0).max(150000).optional(),
  section80D: z.number().min(0).optional(),
  hraExemption: z.number().min(0).optional(),
  otherDeductions: z.number().min(0).optional(),
});

export const taxDeclarationRoutes = async (app: FastifyInstance) => {
  app.post("/api/employees/:employeeId/tax-declaration", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId, employeeId: requestingEmployeeId, role } = request.auth;
    const { employeeId } = employeeIdParamSchema.parse(request.params);
    const body = upsertSchema.parse(request.body);

    const declaration = await upsertTaxDeclaration(prisma, {
      organizationId,
      employeeId,
      financialYear: body.financialYear ?? currentFinancialYear(),
      requestingEmployeeId,
      requestingRole: role,
      ...body,
    });
    return ok({ declaration });
  });

  app.get("/api/employees/:employeeId/tax-declaration", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId, employeeId: requestingEmployeeId, role } = request.auth;
    const { employeeId } = employeeIdParamSchema.parse(request.params);
    const { fy } = fyQuerySchema.parse(request.query);
    const financialYear = fy ?? currentFinancialYear();

    const declaration = await getTaxDeclaration(prisma, { organizationId, employeeId, financialYear, requestingEmployeeId, requestingRole: role });
    return ok({ declaration, financialYear });
  });
};
