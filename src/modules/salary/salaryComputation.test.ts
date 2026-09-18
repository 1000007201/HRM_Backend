import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSalaryStructure, type SalaryComputationComponentInput } from "./salaryComputation.js";

test("resolves FIXED, PERCENTAGE, and BALANCE in one pass", () => {
  const basic: SalaryComputationComponentInput = { id: "basic", sequence: 1, calcType: "FIXED", fixedAmount: 600000 };
  const hra: SalaryComputationComponentInput = {
    id: "hra",
    sequence: 2,
    calcType: "PERCENTAGE",
    percentage: 40,
    baseComponentId: "basic",
  };
  const specialAllowance: SalaryComputationComponentInput = { id: "special", sequence: 3, calcType: "BALANCE" };

  const resolved = computeSalaryStructure(1000000, [basic, hra, specialAllowance]);

  assert.deepEqual(
    resolved.find((r) => r.componentId === "basic"),
    { componentId: "basic", annualAmount: 600000, monthlyAmount: 50000 },
  );
  assert.deepEqual(
    resolved.find((r) => r.componentId === "hra"),
    { componentId: "hra", annualAmount: 240000, monthlyAmount: 20000 },
  );
  assert.deepEqual(
    resolved.find((r) => r.componentId === "special"),
    { componentId: "special", annualAmount: 160000, monthlyAmount: 13333.33 },
  );
});

test("resolves independently of input order — only sequence matters", () => {
  const balance: SalaryComputationComponentInput = { id: "special", sequence: 3, calcType: "BALANCE" };
  const basic: SalaryComputationComponentInput = { id: "basic", sequence: 1, calcType: "FIXED", fixedAmount: 600000 };
  const hra: SalaryComputationComponentInput = {
    id: "hra",
    sequence: 2,
    calcType: "PERCENTAGE",
    percentage: 40,
    baseComponentId: "basic",
  };

  const resolved = computeSalaryStructure(1000000, [balance, basic, hra]);
  assert.equal(resolved.find((r) => r.componentId === "special")?.annualAmount, 160000);
});

test("a PERCENTAGE component based on another PERCENTAGE component resolves correctly", () => {
  const basic: SalaryComputationComponentInput = { id: "basic", sequence: 1, calcType: "FIXED", fixedAmount: 500000 };
  const hra: SalaryComputationComponentInput = {
    id: "hra",
    sequence: 2,
    calcType: "PERCENTAGE",
    percentage: 50,
    baseComponentId: "basic",
  };
  // A (contrived but valid) allowance defined as 10% of HRA, not of basic.
  const hraTopUp: SalaryComputationComponentInput = {
    id: "hraTopUp",
    sequence: 3,
    calcType: "PERCENTAGE",
    percentage: 10,
    baseComponentId: "hra",
  };

  const resolved = computeSalaryStructure(600000, [basic, hra, hraTopUp]);
  assert.equal(resolved.find((r) => r.componentId === "hra")?.annualAmount, 250000);
  assert.equal(resolved.find((r) => r.componentId === "hraTopUp")?.annualAmount, 25000);
});

test("no BALANCE component means every amount comes straight from FIXED/PERCENTAGE", () => {
  const basic: SalaryComputationComponentInput = { id: "basic", sequence: 1, calcType: "FIXED", fixedAmount: 400000 };
  const resolved = computeSalaryStructure(400000, [basic]);
  assert.deepEqual(resolved, [{ componentId: "basic", annualAmount: 400000, monthlyAmount: 33333.33 }]);
});

test("monthly amount is annual / 12 rounded to 2 decimal places", () => {
  const basic: SalaryComputationComponentInput = { id: "basic", sequence: 1, calcType: "FIXED", fixedAmount: 100000 };
  const resolved = computeSalaryStructure(100000, [basic]);
  assert.equal(resolved[0]?.monthlyAmount, 8333.33);
});
