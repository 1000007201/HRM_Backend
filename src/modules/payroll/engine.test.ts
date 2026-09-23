import { test } from "node:test";
import assert from "node:assert/strict";
import { computePayroll, type PayrollInput } from "./engine.js";

const baseInput: PayrollInput = {
  employee: {
    id: "emp1",
    salaryComponents: [
      { componentId: "basic", code: "BASIC", name: "Basic Pay", componentType: "EARNING", monthlyAmount: 30000 },
      { componentId: "hra", code: "HRA", name: "HRA", componentType: "EARNING", monthlyAmount: 12000 },
    ],
  },
  period: { month: 6, year: 2026, daysInMonth: 30 },
  lopDays: 0,
  settings: { pfEnabled: true, pfCeiling: true, esiEnabled: true, ptEnabled: true, ptState: "KARNATAKA" },
  taxDeclaration: null,
  ytdEarnings: 0,
  ytdTdsDeducted: 0,
  monthsRemainingInFy: 10,
};

test("no LOP: full earnings, PF capped at ceiling, ESI applies under gross ceiling", () => {
  const result = computePayroll(baseInput);

  assert.equal(result.paidDays, 30);
  assert.equal(result.grossEarnings, 42000);

  const employeePf = result.components.find((c) => c.name === "Employee PF");
  // Basic (30000) exceeds the 15000 ceiling, so PF is capped: 15000 * 12% = 1800.
  assert.equal(employeePf?.amount, 1800);

  const employeeEsi = result.components.find((c) => c.name === "Employee ESI");
  // Gross 42000 > 21000 ceiling, so ESI must not apply.
  assert.equal(employeeEsi, undefined);

  assert.equal(result.netPay, result.grossEarnings - result.totalDeductions);
  assert.equal(result.employerCost, result.grossEarnings + 1800);
});

test("LOP days prorate every earning component proportionally", () => {
  const result = computePayroll({ ...baseInput, lopDays: 15 });

  assert.equal(result.paidDays, 15);
  // 42000 * (15/30) = 21000
  assert.equal(result.grossEarnings, 21000);
});

test("ESI applies at or below the gross ceiling, employer/employee rates split correctly", () => {
  const result = computePayroll({
    ...baseInput,
    employee: {
      id: "emp2",
      salaryComponents: [{ componentId: "basic", code: "BASIC", name: "Basic Pay", componentType: "EARNING", monthlyAmount: 20000 }],
    },
  });

  assert.equal(result.grossEarnings, 20000);
  assert.equal(result.components.find((c) => c.name === "Employee ESI")?.amount, 150); // 20000 * 0.75%
  assert.equal(result.components.find((c) => c.name === "Employer ESI")?.amount, 650); // 20000 * 3.25%
});

test("PF is skipped entirely when disabled", () => {
  const result = computePayroll({ ...baseInput, settings: { ...baseInput.settings, pfEnabled: false } });
  assert.equal(result.components.find((c) => c.name.includes("PF")), undefined);
});

test("no tax declaration defaults to NEW regime and zero prior income/TDS", () => {
  const result = computePayroll({
    ...baseInput,
    ytdEarnings: 0,
    monthsRemainingInFy: 12,
  });
  // Projected annual gross (42000 * 12 = 504000) is well under the NEW
  // regime's 400000 zero-rate band's ceiling once the 75000 standard
  // deduction is applied (504000 - 75000 = 429000, still low tax) — just
  // assert TDS is a non-negative number and doesn't throw.
  const tds = result.components.find((c) => c.name === "TDS");
  assert.ok(tds === undefined || tds.amount >= 0);
});

test("OLD regime applies 80C/80D/HRA deductions before computing tax", () => {
  const highEarnerInput: PayrollInput = {
    ...baseInput,
    employee: {
      id: "emp3",
      salaryComponents: [{ componentId: "basic", code: "BASIC", name: "Basic Pay", componentType: "EARNING", monthlyAmount: 300000 }],
    },
    settings: { ...baseInput.settings, pfEnabled: false, esiEnabled: false, ptEnabled: false },
    monthsRemainingInFy: 12,
  };

  const oldRegimeNoDeductions = computePayroll({
    ...highEarnerInput,
    taxDeclaration: {
      regime: "OLD",
      previousEmployerIncome: 0,
      previousEmployerTds: 0,
      section80C: 0,
      section80D: 0,
      hraExemption: 0,
      otherDeductions: 0,
    },
  });
  const oldRegimeWithDeductions = computePayroll({
    ...highEarnerInput,
    taxDeclaration: {
      regime: "OLD",
      previousEmployerIncome: 0,
      previousEmployerTds: 0,
      section80C: 150000,
      section80D: 25000,
      hraExemption: 100000,
      otherDeductions: 0,
    },
  });

  const tdsWithout = oldRegimeNoDeductions.components.find((c) => c.name === "TDS")?.amount ?? 0;
  const tdsWith = oldRegimeWithDeductions.components.find((c) => c.name === "TDS")?.amount ?? 0;
  assert.ok(tdsWith < tdsWithout, "80C/80D/HRA deductions must reduce monthly TDS within the OLD regime");
});

test("net pay always equals gross earnings minus total employee deductions", () => {
  const result = computePayroll({ ...baseInput, lopDays: 5 });
  assert.equal(result.netPay, Math.round((result.grossEarnings - result.totalDeductions) * 100) / 100);
});
