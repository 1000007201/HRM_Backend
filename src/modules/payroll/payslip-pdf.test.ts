import { test } from "node:test";
import assert from "node:assert/strict";
import { formatIndianCurrency, generatePayslipPdf, numberToWords } from "./payslip-pdf.js";

test("numberToWords handles zero, tens, hundreds, thousands and lakhs", () => {
  assert.equal(numberToWords(0), "Zero");
  assert.equal(numberToWords(7), "Seven");
  assert.equal(numberToWords(19), "Nineteen");
  assert.equal(numberToWords(42), "Forty Two");
  assert.equal(numberToWords(100), "One Hundred");
  assert.equal(numberToWords(999), "Nine Hundred Ninety Nine");
  assert.equal(numberToWords(1000), "One Thousand");
  assert.equal(numberToWords(50000), "Fifty Thousand");
  assert.equal(numberToWords(123456), "One Lakh Twenty Three Thousand Four Hundred Fifty Six");
  assert.equal(numberToWords(9999999), "Ninety Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine");
});

test("numberToWords rounds fractional amounts", () => {
  assert.equal(numberToWords(1234.6), numberToWords(1235));
});

test("formatIndianCurrency groups by the Indian lakh/crore convention", () => {
  assert.equal(formatIndianCurrency(150000), "₹1,50,000.00");
  assert.equal(formatIndianCurrency(1234.5), "₹1,234.50");
});

test("generatePayslipPdf produces a non-empty PDF buffer", async () => {
  const buffer = await generatePayslipPdf({
    orgName: "Acme Demo Co",
    employeeName: "Ananya Iyer",
    employeeCode: "EMP-0002",
    department: "Sales",
    designation: "Sales Manager",
    month: 1,
    year: 2026,
    daysInMonth: 31,
    paidDays: 9,
    lopDays: 22,
    earnings: [{ name: "Basic Pay", amount: 14516.13 }],
    employeeDeductions: [
      { name: "Employee PF", amount: 1741.94 },
      { name: "Employee ESI", amount: 108.87 },
      { name: "Professional Tax", amount: 200 },
    ],
    employerContributions: [
      { name: "Employer PF", amount: 1741.94 },
      { name: "Employer ESI", amount: 471.77 },
    ],
    grossEarnings: 14516.13,
    totalDeductions: 2050.81,
    netPay: 12465.32,
  });

  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 0);
  // Every PDF file starts with this magic header.
  assert.equal(buffer.subarray(0, 5).toString("latin1"), "%PDF-");
});
