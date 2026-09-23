import type { TaxRegime } from "../../generated/prisma/client.js";

interface TaxSlabBand {
  /** Upper bound of this band's taxable income, inclusive. null = no upper bound. */
  upTo: number | null;
  rate: number;
}

export interface TaxSlabConfig {
  standardDeduction: number;
  slabs: TaxSlabBand[];
}

// Versioned by financial year (Apr-Mar) + regime — the "structure matters
// more than perfection" instruction this module follows. When a union
// budget changes slabs, add a NEW financial year key here; never edit an
// existing one, so a payroll run already processed for FY2025-2026 recomputes
// identically even after FY2026-2027 rules are added (same freeze-the-past
// spirit as SalaryStructureComponent in schema.prisma).
// FY 2025-26 rates, stated by the source spec as applying "FY 2025-26
// onwards" — carried forward unchanged into 2026-2027 (today falls in that
// year) until an actual budget change gives cause to add a distinct entry.
const FY_2025_26_SLABS: Record<TaxRegime, TaxSlabConfig> = {
  NEW: {
    standardDeduction: 75000,
    slabs: [
      { upTo: 400000, rate: 0 },
      { upTo: 800000, rate: 0.05 },
      { upTo: 1200000, rate: 0.1 },
      { upTo: 1600000, rate: 0.15 },
      { upTo: 2000000, rate: 0.2 },
      { upTo: 2400000, rate: 0.25 },
      { upTo: null, rate: 0.3 },
    ],
  },
  OLD: {
    standardDeduction: 50000,
    slabs: [
      { upTo: 250000, rate: 0 },
      { upTo: 500000, rate: 0.05 },
      { upTo: 1000000, rate: 0.2 },
      { upTo: null, rate: 0.3 },
    ],
  },
};

const TAX_SLABS: Record<string, Record<TaxRegime, TaxSlabConfig>> = {
  "2025-2026": FY_2025_26_SLABS,
  "2026-2027": FY_2025_26_SLABS,
};

export const CESS_RATE = 0.04;
export const SECTION_80C_CAP = 150000;

// April..March: month >= 4 means the FY started this calendar year.
export const financialYearFor = (month: number, year: number): string => {
  const startYear = month >= 4 ? year : year - 1;
  return `${startYear}-${startYear + 1}`;
};

// Number of months left in the FY, including the current one — used to
// spread the remaining projected annual tax across the rest of the year.
export const monthsRemainingInFy = (month: number): number => (month >= 4 ? 16 - month : 4 - month);

export const getTaxSlabs = (financialYear: string, regime: TaxRegime): TaxSlabConfig => {
  const forYear = TAX_SLABS[financialYear];
  if (!forYear) {
    throw new Error(`No tax slabs configured for financial year ${financialYear} — add an entry to taxSlabs.ts`);
  }
  return forYear[regime];
};

// Standard progressive-slab tax, band by band.
export const computeAnnualTax = (taxableIncome: number, slabs: TaxSlabBand[]): number => {
  let tax = 0;
  let previousCap = 0;
  for (const band of slabs) {
    if (taxableIncome <= previousCap) break;
    const cap = band.upTo ?? Infinity;
    const taxableInBand = Math.min(taxableIncome, cap) - previousCap;
    tax += taxableInBand * band.rate;
    previousCap = cap;
  }
  return tax;
};
