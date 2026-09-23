import type { ComponentType, TaxRegime } from "../../generated/prisma/client.js";
import { computeProfessionalTax } from "./ptSlabs.js";
import { CESS_RATE, computeAnnualTax, financialYearFor, getTaxSlabs, SECTION_80C_CAP } from "./taxSlabs.js";

// Pure — no DB, no clock, no config reads (see the CLAUDE.md convention for
// derivation.ts/orgChart.ts/accrual.ts, and computeSalaryStructure for the
// sibling pattern in the salary module). Called from payrollRuns.service.ts
// once per employee inside the process transaction. All lookups (active
// salary structure, LOP days, tax declaration, YTD figures) are resolved by
// the caller and passed in — this function only computes.
export interface PayrollSalaryComponentInput {
  componentId: string;
  /** SalaryComponent.code — the stable identifier used to find "Basic Pay"
   *  for PF, since `name` is free text an admin can rename. */
  code: string;
  name: string;
  componentType: ComponentType;
  monthlyAmount: number;
}

export interface PayrollTaxDeclarationInput {
  regime: TaxRegime;
  previousEmployerIncome: number;
  previousEmployerTds: number;
  section80C: number;
  section80D: number;
  hraExemption: number;
  otherDeductions: number;
}

export interface PayrollSettingsInput {
  pfEnabled: boolean;
  pfCeiling: boolean;
  esiEnabled: boolean;
  ptEnabled: boolean;
  ptState: string | null;
}

export interface PayrollInput {
  employee: {
    id: string;
    /** Only EARNING-type components from the active salary structure are
     *  prorated (Pass 1) — deductions/contributions the engine itself
     *  generates (PF/ESI/PT/TDS) come from the passes below, not from here. */
    salaryComponents: PayrollSalaryComponentInput[];
  };
  period: { month: number; year: number; daysInMonth: number };
  lopDays: number;
  settings: PayrollSettingsInput;
  taxDeclaration: PayrollTaxDeclarationInput | null;
  ytdEarnings: number;
  ytdTdsDeducted: number;
  monthsRemainingInFy: number;
}

export interface PayrollComponentOutput {
  componentId: string | null;
  name: string;
  componentType: ComponentType;
  amount: number;
}

export interface PayrollOutput {
  paidDays: number;
  components: PayrollComponentOutput[];
  grossEarnings: number;
  totalDeductions: number;
  netPay: number;
  employerCost: number;
}

// Frozen text for the statutory lines the engine itself generates (no
// SalaryComponent row backs these — componentId is null). Exported so
// ytd.ts can find prior TDS amounts by the same literal, keeping the two in
// sync.
export const STATUTORY_COMPONENT_NAMES = {
  EMPLOYEE_PF: "Employee PF",
  EMPLOYER_PF: "Employer PF",
  EMPLOYEE_ESI: "Employee ESI",
  EMPLOYER_ESI: "Employer ESI",
  PROFESSIONAL_TAX: "Professional Tax",
  TDS: "TDS",
} as const;

const PF_RATE = 0.12;
const PF_WAGE_CEILING = 15000;
const ESI_EMPLOYEE_RATE = 0.0075;
const ESI_EMPLOYER_RATE = 0.0325;
const ESI_GROSS_CEILING = 21000;

const round2 = (value: number): number => Math.round(value * 100) / 100;

export const computePayroll = (input: PayrollInput): PayrollOutput => {
  const { employee, period, lopDays, settings, taxDeclaration, ytdEarnings, ytdTdsDeducted, monthsRemainingInFy } = input;

  const paidDays = Math.max(0, period.daysInMonth - lopDays);
  const prorationFactor = period.daysInMonth > 0 ? paidDays / period.daysInMonth : 0;

  // Pass 1 — LOP proration of every EARNING component.
  const earningComponents = employee.salaryComponents.filter((component) => component.componentType === "EARNING");
  const components: PayrollComponentOutput[] = earningComponents.map((component) => ({
    componentId: component.componentId,
    name: component.name,
    componentType: component.componentType,
    amount: round2(component.monthlyAmount * prorationFactor),
  }));

  const grossEarnings = round2(components.reduce((sum, component) => sum + component.amount, 0));

  // Pass 2 — PF.
  if (settings.pfEnabled) {
    const basicComponent = earningComponents.find((component) => component.code.toUpperCase() === "BASIC");
    const proratedBasic = basicComponent ? round2(basicComponent.monthlyAmount * prorationFactor) : 0;
    const pfWageBase = settings.pfCeiling ? Math.min(proratedBasic, PF_WAGE_CEILING) : proratedBasic;
    const employeePf = round2(pfWageBase * PF_RATE);
    const employerPf = round2(pfWageBase * PF_RATE);
    components.push(
      { componentId: null, name: STATUTORY_COMPONENT_NAMES.EMPLOYEE_PF, componentType: "EMPLOYEE_DEDUCTION", amount: employeePf },
      { componentId: null, name: STATUTORY_COMPONENT_NAMES.EMPLOYER_PF, componentType: "EMPLOYER_CONTRIBUTION", amount: employerPf },
    );
  }

  // Pass 3 — ESI, only below the gross ceiling.
  if (settings.esiEnabled && grossEarnings <= ESI_GROSS_CEILING) {
    components.push(
      {
        componentId: null,
        name: STATUTORY_COMPONENT_NAMES.EMPLOYEE_ESI,
        componentType: "EMPLOYEE_DEDUCTION",
        amount: round2(grossEarnings * ESI_EMPLOYEE_RATE),
      },
      {
        componentId: null,
        name: STATUTORY_COMPONENT_NAMES.EMPLOYER_ESI,
        componentType: "EMPLOYER_CONTRIBUTION",
        amount: round2(grossEarnings * ESI_EMPLOYER_RATE),
      },
    );
  }

  // Pass 4 — Professional Tax.
  if (settings.ptEnabled && settings.ptState) {
    const ptAmount = computeProfessionalTax(settings.ptState, grossEarnings, period.month);
    if (ptAmount > 0) {
      components.push({ componentId: null, name: STATUTORY_COMPONENT_NAMES.PROFESSIONAL_TAX, componentType: "EMPLOYEE_DEDUCTION", amount: ptAmount });
    }
  }

  // Pass 5 — TDS. No declaration on file defaults to the NEW-regime slabs
  // with every optional field at 0 (matches EmployeeTaxDeclaration.regime's
  // schema default).
  const regime = taxDeclaration?.regime ?? "NEW";
  const financialYear = financialYearFor(period.month, period.year);
  const slabConfig = getTaxSlabs(financialYear, regime);

  const projectedAnnualGross = ytdEarnings + grossEarnings * monthsRemainingInFy;
  let taxableIncome = projectedAnnualGross + (taxDeclaration?.previousEmployerIncome ?? 0) - slabConfig.standardDeduction;
  if (regime === "OLD" && taxDeclaration) {
    taxableIncome -=
      Math.min(taxDeclaration.section80C, SECTION_80C_CAP) +
      taxDeclaration.section80D +
      taxDeclaration.hraExemption +
      taxDeclaration.otherDeductions;
  }
  taxableIncome = Math.max(0, taxableIncome);

  const annualTaxWithCess = computeAnnualTax(taxableIncome, slabConfig.slabs) * (1 + CESS_RATE);
  const tdsAlreadyPaid = (taxDeclaration?.previousEmployerTds ?? 0) + ytdTdsDeducted;
  const remainingTax = annualTaxWithCess - tdsAlreadyPaid;
  const monthlyTds = remainingTax <= 0 || monthsRemainingInFy <= 0 ? 0 : round2(remainingTax / monthsRemainingInFy);
  if (monthlyTds > 0) {
    components.push({ componentId: null, name: STATUTORY_COMPONENT_NAMES.TDS, componentType: "EMPLOYEE_DEDUCTION", amount: monthlyTds });
  }

  // Pass 6 — Totals.
  const totalDeductions = round2(
    components.filter((component) => component.componentType === "EMPLOYEE_DEDUCTION").reduce((sum, component) => sum + component.amount, 0),
  );
  const totalEmployerContributions = round2(
    components.filter((component) => component.componentType === "EMPLOYER_CONTRIBUTION").reduce((sum, component) => sum + component.amount, 0),
  );

  return {
    paidDays,
    components,
    grossEarnings,
    totalDeductions,
    netPay: round2(grossEarnings - totalDeductions),
    employerCost: round2(grossEarnings + totalEmployerContributions),
  };
};
