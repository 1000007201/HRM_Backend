import type { CalcType, ComponentType, PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../core/errors.js";

// Business operations for the org-level salary-component rulebook. Routes
// parse input, authorize, and call one of these.

interface CalcTypeShape {
  fixedAmount?: number | null;
  percentage?: number | null;
  baseComponentId?: string | null;
}

// Checks only the SHAPE of the calcType/fixedAmount/percentage/baseComponentId
// combination — no DB access, so it's reusable as-is for both create (where
// everything is fresh input) and update (where the caller merges the patch
// onto the existing row first, then re-runs this against the merged result).
const assertValidCalcTypeShape = (calcType: CalcType, shape: CalcTypeShape): void => {
  const { fixedAmount, percentage, baseComponentId } = shape;

  if (calcType === "FIXED") {
    if (fixedAmount === null || fixedAmount === undefined) {
      throw new AppError(400, "VALIDATION", "fixedAmount is required for a FIXED component");
    }
    if (percentage !== null && percentage !== undefined) {
      throw new AppError(400, "VALIDATION", "percentage must not be set for a FIXED component");
    }
    if (baseComponentId !== null && baseComponentId !== undefined) {
      throw new AppError(400, "VALIDATION", "baseComponentId must not be set for a FIXED component");
    }
  } else if (calcType === "PERCENTAGE") {
    if (percentage === null || percentage === undefined) {
      throw new AppError(400, "VALIDATION", "percentage is required for a PERCENTAGE component");
    }
    if (!baseComponentId) {
      throw new AppError(400, "VALIDATION", "baseComponentId is required for a PERCENTAGE component");
    }
    if (fixedAmount !== null && fixedAmount !== undefined) {
      throw new AppError(400, "VALIDATION", "fixedAmount must not be set for a PERCENTAGE component");
    }
  } else {
    // BALANCE — it's the remainder, so none of the other three mean anything.
    if (
      (fixedAmount !== null && fixedAmount !== undefined) ||
      (percentage !== null && percentage !== undefined) ||
      (baseComponentId !== null && baseComponentId !== undefined)
    ) {
      throw new AppError(
        400,
        "VALIDATION",
        "A BALANCE component must not set fixedAmount, percentage, or baseComponentId",
      );
    }
  }
};

interface OrderableComponent {
  id: string;
  calcType: CalcType;
  sequence: number;
  baseComponentId: string | null;
}

// Validates the FULL set of an org's active components (the proposed
// create/update already merged in) against every ordering rule at once:
//   - sequence is unique across the set
//   - every FIXED component's sequence < every PERCENTAGE component's
//   - every PERCENTAGE/FIXED component's sequence < the BALANCE component's
//   - a PERCENTAGE component's own sequence > its baseComponent's sequence
//     (this is also what rules out a cycle: A based on B based on A would
//     require both A.sequence > B.sequence and B.sequence > A.sequence)
// Re-run against the WHOLE set (not just the row being changed) on every
// write, since editing one component's sequence can silently break another
// component's base-before-dependent invariant.
const validateComponentOrdering = (components: OrderableComponent[]): void => {
  const seenSequences = new Set<number>();
  for (const component of components) {
    if (seenSequences.has(component.sequence)) {
      throw new AppError(409, "CONFLICT", `sequence ${component.sequence} is already used by another component`);
    }
    seenSequences.add(component.sequence);
  }

  const sequencesByCalcType = (calcType: CalcType): number[] =>
    components.filter((component) => component.calcType === calcType).map((component) => component.sequence);

  const maxFixedSequence = Math.max(-Infinity, ...sequencesByCalcType("FIXED"));
  const minPercentageSequence = Math.min(Infinity, ...sequencesByCalcType("PERCENTAGE"));
  const maxPercentageSequence = Math.max(-Infinity, ...sequencesByCalcType("PERCENTAGE"));
  const minBalanceSequence = Math.min(Infinity, ...sequencesByCalcType("BALANCE"));

  if (minPercentageSequence <= maxFixedSequence) {
    throw new AppError(
      400,
      "VALIDATION",
      "Every PERCENTAGE component's sequence must come after every FIXED component's sequence",
    );
  }
  if (minBalanceSequence <= maxFixedSequence || minBalanceSequence <= maxPercentageSequence) {
    throw new AppError(
      400,
      "VALIDATION",
      "The BALANCE component's sequence must come after every FIXED and PERCENTAGE component's sequence",
    );
  }

  const componentById = new Map(components.map((component) => [component.id, component]));
  for (const component of components) {
    if (component.calcType === "PERCENTAGE" && component.baseComponentId) {
      const baseComponent = componentById.get(component.baseComponentId);
      if (baseComponent && baseComponent.sequence >= component.sequence) {
        throw new AppError(
          400,
          "VALIDATION",
          "A component's baseComponentId must have a lower sequence than the component itself",
        );
      }
    }
  }
};

// Soft-delete only, so a component still referenced by a historical (already
// superseded) SalaryStructure keeps its label — only an employee's CURRENT
// active structure (effectiveTo: null) blocks deactivation.
const assertNotReferencedByActiveStructure = async (prisma: PrismaClient, componentId: string): Promise<void> => {
  const referenced = await prisma.salaryStructureComponent.findFirst({
    where: { componentId, structure: { effectiveTo: null } },
  });
  if (referenced) {
    throw new AppError(
      409,
      "CONFLICT",
      "Cannot deactivate a component referenced by an employee's active salary structure",
    );
  }
};

export interface CreateSalaryComponentParams {
  organizationId: string;
  name: string;
  code: string;
  componentType: ComponentType;
  calcType: CalcType;
  fixedAmount?: number;
  percentage?: number;
  baseComponentId?: string;
  sequence: number;
}

export const createSalaryComponent = async (prisma: PrismaClient, params: CreateSalaryComponentParams) => {
  const { organizationId, name, code, componentType, calcType, fixedAmount, percentage, baseComponentId, sequence } =
    params;

  assertValidCalcTypeShape(calcType, { fixedAmount, percentage, baseComponentId });

  let resolvedBaseComponentId: string | null = null;
  if (calcType === "PERCENTAGE") {
    const baseComponent = await prisma.salaryComponent.findFirst({
      where: { id: baseComponentId, organizationId, isActive: true },
    });
    if (!baseComponent) {
      throw new AppError(400, "VALIDATION", "baseComponentId must reference an active component in your organization");
    }
    resolvedBaseComponentId = baseComponent.id;
  }

  // Scoped to ACTIVE components only: a deactivated BALANCE component frees
  // up the slot for a new one, same reasoning as the reference guard above —
  // isActive means "retired from use", not "permanently reserved".
  if (calcType === "BALANCE") {
    const existingBalance = await prisma.salaryComponent.findFirst({
      where: { organizationId, calcType: "BALANCE", isActive: true },
    });
    if (existingBalance) {
      throw new AppError(409, "CONFLICT", "This organization already has an active BALANCE component");
    }
  }

  const otherActiveComponents = await prisma.salaryComponent.findMany({
    where: { organizationId, isActive: true },
    select: { id: true, calcType: true, sequence: true, baseComponentId: true },
  });
  validateComponentOrdering([
    ...otherActiveComponents,
    { id: "__pending__", calcType, sequence, baseComponentId: resolvedBaseComponentId },
  ]);

  // Duplicate code in-org is caught by the organizationId_code unique
  // constraint and mapped to 409 CONFLICT centrally — no pre-check needed.
  return prisma.salaryComponent.create({
    data: {
      organizationId,
      name,
      code,
      componentType,
      calcType,
      fixedAmount,
      percentage,
      baseComponentId: resolvedBaseComponentId,
      sequence,
    },
  });
};

export interface UpdateSalaryComponentParams {
  name?: string;
  code?: string;
  componentType?: ComponentType;
  calcType?: CalcType;
  fixedAmount?: number | null;
  percentage?: number | null;
  baseComponentId?: string | null;
  sequence?: number;
  isActive?: boolean;
}

export const updateSalaryComponent = async (
  prisma: PrismaClient,
  params: { id: string; organizationId: string; input: UpdateSalaryComponentParams },
) => {
  const { id, organizationId, input } = params;

  const existing = await prisma.salaryComponent.findFirst({ where: { id, organizationId } });
  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "Salary component not found");
  }

  if (input.isActive === false && existing.isActive) {
    await assertNotReferencedByActiveStructure(prisma, id);
  }

  const mergedCalcType = input.calcType ?? existing.calcType;
  const mergedFixedAmount = input.fixedAmount !== undefined ? input.fixedAmount : existing.fixedAmount?.toNumber();
  const mergedPercentage = input.percentage !== undefined ? input.percentage : existing.percentage?.toNumber();
  const mergedBaseComponentId =
    input.baseComponentId !== undefined ? input.baseComponentId : existing.baseComponentId;

  assertValidCalcTypeShape(mergedCalcType, {
    fixedAmount: mergedFixedAmount,
    percentage: mergedPercentage,
    baseComponentId: mergedBaseComponentId,
  });

  let resolvedBaseComponentId: string | null = null;
  if (mergedCalcType === "PERCENTAGE") {
    const baseComponent = await prisma.salaryComponent.findFirst({
      where: { id: mergedBaseComponentId ?? undefined, organizationId, isActive: true },
    });
    if (!baseComponent) {
      throw new AppError(400, "VALIDATION", "baseComponentId must reference an active component in your organization");
    }
    resolvedBaseComponentId = baseComponent.id;
  }

  if (mergedCalcType === "BALANCE" && existing.calcType !== "BALANCE") {
    const existingBalance = await prisma.salaryComponent.findFirst({
      where: { organizationId, calcType: "BALANCE", isActive: true, id: { not: id } },
    });
    if (existingBalance) {
      throw new AppError(409, "CONFLICT", "This organization already has an active BALANCE component");
    }
  }

  const mergedSequence = input.sequence ?? existing.sequence;
  const mergedIsActive = input.isActive ?? existing.isActive;
  if (mergedIsActive) {
    const otherActiveComponents = await prisma.salaryComponent.findMany({
      where: { organizationId, isActive: true, id: { not: id } },
      select: { id: true, calcType: true, sequence: true, baseComponentId: true },
    });
    validateComponentOrdering([
      ...otherActiveComponents,
      { id, calcType: mergedCalcType, sequence: mergedSequence, baseComponentId: resolvedBaseComponentId },
    ]);
  }

  return prisma.salaryComponent.update({
    where: { id },
    data: {
      name: input.name,
      code: input.code,
      componentType: input.componentType,
      calcType: mergedCalcType,
      fixedAmount: mergedCalcType === "FIXED" ? mergedFixedAmount : null,
      percentage: mergedCalcType === "PERCENTAGE" ? mergedPercentage : null,
      baseComponentId: resolvedBaseComponentId,
      sequence: mergedSequence,
      isActive: input.isActive,
    },
  });
};

export const deactivateSalaryComponent = async (
  prisma: PrismaClient,
  params: { id: string; organizationId: string },
) => {
  const { id, organizationId } = params;

  const existing = await prisma.salaryComponent.findFirst({ where: { id, organizationId } });
  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "Salary component not found");
  }

  await assertNotReferencedByActiveStructure(prisma, id);

  return prisma.salaryComponent.update({ where: { id }, data: { isActive: false } });
};
