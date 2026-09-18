import type { CalcType } from "../../generated/prisma/client.js";

// Pure — no DB, no clock, no config reads (see the CLAUDE.md convention for
// derivation.ts/orgChart.ts/accrual.ts). Called from salaryStructures.service.ts
// to compute the amounts that get frozen onto a new SalaryStructure, and
// meant to be mirrored client-side for the frontend's live preview — see the
// model comment on SalaryStructureComponent in schema.prisma for why the
// result is frozen rather than recomputed later.
export interface SalaryComputationComponentInput {
  id: string;
  sequence: number;
  calcType: CalcType;
  fixedAmount?: number | null;
  percentage?: number | null;
  baseComponentId?: string | null;
}

export interface ResolvedSalaryComponent {
  componentId: string;
  monthlyAmount: number;
  annualAmount: number;
}

const roundToRupees = (value: number): number => Math.round(value * 100) / 100;

// Three passes, in the order the ordering rule (see validateComponentOrdering
// in salaryComponents.service.ts) guarantees is safe:
//   1. FIXED — resolved as-is, no dependency on anything else.
//   2. PERCENTAGE — reads its baseComponent's already-resolved annual amount.
//      Requires the base to have a lower `sequence` (enforced at the
//      component-definition level, not here) so it's always resolved by the
//      time this pass reaches a component that depends on it.
//   3. BALANCE — whatever's left of annualCtc after every other component;
//      there is at most one (enforced at the component-definition level).
export const computeSalaryStructure = (
  annualCtc: number,
  components: SalaryComputationComponentInput[],
): ResolvedSalaryComponent[] => {
  const sortedBySequence = [...components].sort((a, b) => a.sequence - b.sequence);
  const resolvedAnnualById = new Map<string, number>();

  for (const component of sortedBySequence) {
    if (component.calcType === "FIXED") {
      resolvedAnnualById.set(component.id, component.fixedAmount ?? 0);
    }
  }

  for (const component of sortedBySequence) {
    if (component.calcType === "PERCENTAGE") {
      const baseAnnual = component.baseComponentId ? (resolvedAnnualById.get(component.baseComponentId) ?? 0) : 0;
      resolvedAnnualById.set(component.id, (baseAnnual * (component.percentage ?? 0)) / 100);
    }
  }

  const balanceComponent = sortedBySequence.find((component) => component.calcType === "BALANCE");
  if (balanceComponent) {
    const othersAnnualTotal = sortedBySequence
      .filter((component) => component.id !== balanceComponent.id)
      .reduce((sum, component) => sum + (resolvedAnnualById.get(component.id) ?? 0), 0);
    resolvedAnnualById.set(balanceComponent.id, annualCtc - othersAnnualTotal);
  }

  return sortedBySequence.map((component) => {
    const annualAmount = roundToRupees(resolvedAnnualById.get(component.id) ?? 0);
    return { componentId: component.id, annualAmount, monthlyAmount: roundToRupees(annualAmount / 12) };
  });
};
