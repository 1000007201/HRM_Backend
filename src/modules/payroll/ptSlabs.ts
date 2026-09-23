// Professional Tax monthly slabs by state — code constants, not DB rows (see
// the schema comment on PayrollSettings.ptState): easier to audit and deploy
// than a settings table HR could accidentally edit. Approximate — verify
// against the current state notification before relying on this for real
// compliance. Only states with numbers given/verified are implemented;
// everything else resolves to 0 rather than guessing at unverified slabs
// (a wrong PT deduction is a money bug — see CLAUDE.md).
//
// Add a state by adding a case here — no schema change needed, ptState is a
// plain string precisely so this list can grow without a migration.
export const computeProfessionalTax = (state: string | null, monthlyGross: number, month: number): number => {
  switch (state) {
    case "MAHARASHTRA":
      if (monthlyGross <= 7500) return 0;
      if (monthlyGross <= 10000) return 175;
      // Feb carries the extra ₹100 that caps the annual total at ₹2,500
      // (11 months x 200 + 1 month x 300 = 2,500).
      return month === 2 ? 300 : 200;
    case "KARNATAKA":
      return monthlyGross <= 15000 ? 0 : 200;
    default:
      // TODO: add slabs for other states as customers need them.
      return 0;
  }
};
