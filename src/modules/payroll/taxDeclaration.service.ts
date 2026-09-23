import type { EmployeeRole, PrismaClient, TaxRegime } from "../../generated/prisma/client.js";
import { AppError } from "../../core/errors.js";
import { financialYearFor, SECTION_80C_CAP } from "./taxSlabs.js";

export const currentFinancialYear = (): string => {
  const now = new Date();
  return financialYearFor(now.getUTCMonth() + 1, now.getUTCFullYear());
};

const assertCanManageEmployeeResource = (requestingRole: EmployeeRole, requestingEmployeeId: string, employeeId: string) => {
  if (requestingRole !== "ADMIN" && requestingEmployeeId !== employeeId) {
    throw new AppError(403, "FORBIDDEN", "You may only manage your own tax declaration");
  }
};

export interface UpsertTaxDeclarationParams {
  organizationId: string;
  employeeId: string;
  financialYear: string;
  regime: TaxRegime;
  requestingEmployeeId: string;
  requestingRole: EmployeeRole;
  previousEmployerIncome?: number;
  previousEmployerTds?: number;
  section80C?: number;
  section80D?: number;
  hraExemption?: number;
  otherDeductions?: number;
}

export const upsertTaxDeclaration = async (prisma: PrismaClient, params: UpsertTaxDeclarationParams) => {
  const { organizationId, employeeId, financialYear, regime, requestingEmployeeId, requestingRole, ...rest } = params;
  assertCanManageEmployeeResource(requestingRole, requestingEmployeeId, employeeId);

  const employee = await prisma.employee.findFirst({ where: { id: employeeId, organizationId } });
  if (!employee) {
    throw new AppError(404, "NOT_FOUND", "Employee not found");
  }

  if (rest.section80C !== undefined && rest.section80C > SECTION_80C_CAP) {
    throw new AppError(400, "VALIDATION", `Section 80C cannot exceed ₹${SECTION_80C_CAP.toLocaleString("en-IN")}`);
  }

  // Old-regime-only fields are cleared under NEW — see the schema comment on
  // EmployeeTaxDeclaration.
  const oldRegimeFields =
    regime === "NEW"
      ? { section80C: null, section80D: null, hraExemption: null }
      : { section80C: rest.section80C ?? null, section80D: rest.section80D ?? null, hraExemption: rest.hraExemption ?? null };

  const data = {
    regime,
    ...oldRegimeFields,
    previousEmployerIncome: rest.previousEmployerIncome ?? null,
    previousEmployerTds: rest.previousEmployerTds ?? null,
    otherDeductions: rest.otherDeductions ?? null,
  };

  return prisma.employeeTaxDeclaration.upsert({
    where: { employeeId_financialYear: { employeeId, financialYear } },
    create: { organizationId, employeeId, financialYear, ...data },
    update: data,
  });
};

export const getTaxDeclaration = async (
  prisma: PrismaClient,
  params: { organizationId: string; employeeId: string; financialYear: string; requestingEmployeeId: string; requestingRole: EmployeeRole },
) => {
  const { organizationId, employeeId, financialYear, requestingEmployeeId, requestingRole } = params;
  assertCanManageEmployeeResource(requestingRole, requestingEmployeeId, employeeId);

  const employee = await prisma.employee.findFirst({ where: { id: employeeId, organizationId } });
  if (!employee) {
    throw new AppError(404, "NOT_FOUND", "Employee not found");
  }

  return prisma.employeeTaxDeclaration.findUnique({ where: { employeeId_financialYear: { employeeId, financialYear } } });
};
