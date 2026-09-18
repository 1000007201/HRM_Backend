import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../core/errors.js";

const structureInclude = { components: { include: { component: true } } } as const;

export interface CreateSalaryStructureComponentInput {
  componentId: string;
  monthlyAmount: number;
  annualAmount: number;
}

export interface CreateSalaryStructureParams {
  organizationId: string;
  employeeId: string;
  annualCtc: number;
  effectiveFrom: Date;
  components: CreateSalaryStructureComponentInput[];
}

// The frontend (or an admin re-checking by hand) computes these amounts via
// computeSalaryStructure and posts the result; this just re-validates the
// invariant that has to hold regardless of who computed it — the resolved
// EARNING amounts must actually add up to the CTC being assigned. A ₹1
// tolerance absorbs rounding from the monthly-amount division, not sloppy input.
const EARNING_SUM_TOLERANCE_RUPEES = 1;

export const createSalaryStructure = async (prisma: PrismaClient, params: CreateSalaryStructureParams) => {
  const { organizationId, employeeId, annualCtc, effectiveFrom, components } = params;

  const employee = await prisma.employee.findFirst({ where: { id: employeeId, organizationId } });
  if (!employee) {
    throw new AppError(404, "NOT_FOUND", "Employee not found");
  }

  if (components.length === 0) {
    throw new AppError(400, "VALIDATION", "At least one component is required");
  }

  const componentIds = components.map((component) => component.componentId);
  if (new Set(componentIds).size !== componentIds.length) {
    throw new AppError(400, "VALIDATION", "Each component may only appear once in a salary structure");
  }

  const salaryComponents = await prisma.salaryComponent.findMany({
    where: { id: { in: componentIds }, organizationId, isActive: true },
  });
  if (salaryComponents.length !== componentIds.length) {
    throw new AppError(400, "VALIDATION", "Every componentId must reference an active component in your organization");
  }

  const componentById = new Map(salaryComponents.map((component) => [component.id, component]));
  const earningAnnualTotal = components.reduce((sum, component) => {
    const salaryComponent = componentById.get(component.componentId)!;
    return salaryComponent.componentType === "EARNING" ? sum.plus(component.annualAmount) : sum;
  }, new Prisma.Decimal(0));

  if (earningAnnualTotal.minus(annualCtc).abs().greaterThan(EARNING_SUM_TOLERANCE_RUPEES)) {
    throw new AppError(
      400,
      "VALIDATION",
      `The sum of EARNING component annual amounts (₹${earningAnnualTotal.toFixed(2)}) must equal annualCtc (₹${annualCtc.toFixed(2)})`,
    );
  }

  // Serializable: reading the current active structure, closing it out, and
  // creating the new one is a read-then-write two concurrent submissions for
  // the same employee could otherwise both pass under READ COMMITTED — same
  // reasoning as leave/regularization approval.
  return prisma.$transaction(
    async (tx) => {
      const activeStructure = await tx.salaryStructure.findFirst({ where: { employeeId, effectiveTo: null } });
      if (activeStructure) {
        if (effectiveFrom <= activeStructure.effectiveFrom) {
          throw new AppError(
            400,
            "VALIDATION",
            "effectiveFrom must be strictly after the current active structure's effectiveFrom",
          );
        }
        const closesOldStructureOn = new Date(effectiveFrom);
        closesOldStructureOn.setUTCDate(closesOldStructureOn.getUTCDate() - 1);
        await tx.salaryStructure.update({
          where: { id: activeStructure.id },
          data: { effectiveTo: closesOldStructureOn },
        });
      }

      const structure = await tx.salaryStructure.create({
        data: { organizationId, employeeId, annualCtc, effectiveFrom },
      });

      await tx.salaryStructureComponent.createMany({
        data: components.map((component) => ({
          structureId: structure.id,
          componentId: component.componentId,
          monthlyAmount: component.monthlyAmount,
          annualAmount: component.annualAmount,
        })),
      });

      return tx.salaryStructure.findUniqueOrThrow({ where: { id: structure.id }, include: structureInclude });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
};

export const getActiveSalaryStructure = async (
  prisma: PrismaClient,
  params: { organizationId: string; employeeId: string },
) => {
  const { organizationId, employeeId } = params;

  const employee = await prisma.employee.findFirst({ where: { id: employeeId, organizationId } });
  if (!employee) {
    throw new AppError(404, "NOT_FOUND", "Employee not found");
  }

  const structure = await prisma.salaryStructure.findFirst({
    where: { employeeId, effectiveTo: null },
    include: structureInclude,
  });
  if (!structure) {
    throw new AppError(404, "NOT_FOUND", "This employee has no active salary structure");
  }

  return structure;
};

export const listSalaryStructureHistory = async (
  prisma: PrismaClient,
  params: { organizationId: string; employeeId: string },
) => {
  const { organizationId, employeeId } = params;

  const employee = await prisma.employee.findFirst({ where: { id: employeeId, organizationId } });
  if (!employee) {
    throw new AppError(404, "NOT_FOUND", "Employee not found");
  }

  return prisma.salaryStructure.findMany({
    where: { employeeId },
    include: structureInclude,
    orderBy: { effectiveFrom: "desc" },
  });
};
