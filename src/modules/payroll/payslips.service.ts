import type { EmployeeRole, PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../core/errors.js";
import { generatePayslipPdf } from "./payslip-pdf.js";
import { getAbsolutePdfPath, savePayslipPdf } from "./payslip-storage.js";

export const listPayslipsForRun = async (prisma: PrismaClient, params: { organizationId: string; runId: string }) => {
  const { organizationId, runId } = params;
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, organizationId } });
  if (!run) {
    throw new AppError(404, "NOT_FOUND", "Payroll run not found");
  }

  return prisma.payslip.findMany({
    where: { payrollRunId: runId },
    include: { employee: { select: { id: true, fullName: true, employeeCode: true } } },
    orderBy: { employee: { fullName: "asc" } },
  });
};

// Shared by all three "own resource or admin" functions in this module.
const assertCanViewEmployeeResource = (requestingRole: EmployeeRole, requestingEmployeeId: string, employeeId: string) => {
  if (requestingRole !== "ADMIN" && requestingEmployeeId !== employeeId) {
    throw new AppError(403, "FORBIDDEN", "You may only view your own payslips");
  }
};

// Admin can view any payslip in the run at any status (they need this while
// reviewing, before approval). An employee viewing their own payslip is
// further restricted to APPROVED/PAID runs — same reasoning as
// listEmployeePayslips: no draft numbers that might still change.
export const getPayslip = async (
  prisma: PrismaClient,
  params: { organizationId: string; runId: string; payslipId: string; requestingEmployeeId: string; requestingRole: EmployeeRole },
) => {
  const { organizationId, runId, payslipId, requestingEmployeeId, requestingRole } = params;
  const payslip = await prisma.payslip.findFirst({
    where: { id: payslipId, payrollRunId: runId, payrollRun: { organizationId } },
    include: {
      components: true,
      employee: { select: { id: true, fullName: true, employeeCode: true, designation: true, department: { select: { name: true } } } },
      payrollRun: { select: { month: true, year: true, status: true } },
    },
  });
  if (!payslip) {
    throw new AppError(404, "NOT_FOUND", "Payslip not found");
  }

  assertCanViewEmployeeResource(requestingRole, requestingEmployeeId, payslip.employeeId);
  if (requestingRole !== "ADMIN" && payslip.payrollRun.status !== "APPROVED" && payslip.payrollRun.status !== "PAID") {
    throw new AppError(403, "FORBIDDEN", "This payslip is not available yet");
  }

  return payslip;
};

export const listEmployeePayslips = async (
  prisma: PrismaClient,
  params: { organizationId: string; employeeId: string; requestingEmployeeId: string; requestingRole: EmployeeRole },
) => {
  const { organizationId, employeeId, requestingEmployeeId, requestingRole } = params;
  assertCanViewEmployeeResource(requestingRole, requestingEmployeeId, employeeId);

  const employee = await prisma.employee.findFirst({ where: { id: employeeId, organizationId } });
  if (!employee) {
    throw new AppError(404, "NOT_FOUND", "Employee not found");
  }

  // Only APPROVED/PAID runs — an employee shouldn't see draft numbers that
  // might still change before approval.
  return prisma.payslip.findMany({
    where: { employeeId, payrollRun: { organizationId, status: { in: ["APPROVED", "PAID"] } } },
    include: { payrollRun: { select: { month: true, year: true, status: true } } },
    orderBy: [{ payrollRun: { year: "desc" } }, { payrollRun: { month: "desc" } }],
  });
};

const buildPayslipFileName = (employeeName: string, month: number, year: number): string => {
  const monthStr = String(month).padStart(2, "0");
  return `payslip-${monthStr}-${year}-${employeeName.replace(/\s+/g, "-")}.pdf`;
};

export interface GeneratedPayslipPdf {
  pdfBuffer: Buffer;
  pdfPath: string;
  fileName: string;
  employeeEmail: string;
  employeeName: string;
  month: number;
  year: number;
}

// Fetches everything a payslip PDF needs, renders it, writes it to disk, and
// stamps pdfPath/pdfGeneratedAt on the row. Called from three places — the
// queue worker (payslip-worker.ts) and the on-the-fly fallback in both the
// single-download and bulk-download routes below — so every code path that
// serves a PDF shares exactly one generator, never two implementations that
// could drift apart.
export const generateAndStorePayslipPdf = async (
  prisma: PrismaClient,
  params: { organizationId: string; payslipId: string },
): Promise<GeneratedPayslipPdf> => {
  const { organizationId, payslipId } = params;

  const [payslip, organization] = await Promise.all([
    prisma.payslip.findFirst({
      where: { id: payslipId, payrollRun: { organizationId } },
      include: {
        components: true,
        employee: { select: { fullName: true, email: true, employeeCode: true, designation: true, department: { select: { name: true } } } },
        payrollRun: { select: { month: true, year: true } },
      },
    }),
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true } }),
  ]);
  if (!payslip) {
    throw new AppError(404, "NOT_FOUND", "Payslip not found");
  }

  const byType = (type: string) =>
    payslip.components.filter((component) => component.componentType === type).map((component) => ({ name: component.name, amount: component.amount.toNumber() }));

  const pdfBuffer = await generatePayslipPdf({
    orgName: organization.name,
    employeeName: payslip.employee.fullName,
    employeeCode: payslip.employee.employeeCode ?? "—",
    department: payslip.employee.department?.name ?? null,
    designation: payslip.employee.designation,
    month: payslip.payrollRun.month,
    year: payslip.payrollRun.year,
    daysInMonth: payslip.daysInMonth,
    paidDays: payslip.paidDays,
    lopDays: payslip.lopDays,
    earnings: byType("EARNING"),
    employeeDeductions: byType("EMPLOYEE_DEDUCTION"),
    employerContributions: byType("EMPLOYER_CONTRIBUTION"),
    grossEarnings: payslip.grossEarnings.toNumber(),
    totalDeductions: payslip.totalDeductions.toNumber(),
    netPay: payslip.netPay.toNumber(),
  });

  const pdfPath = await savePayslipPdf(organizationId, payslip.payrollRun.year, payslip.payrollRun.month, payslip.employeeId, pdfBuffer);
  await prisma.payslip.update({ where: { id: payslip.id }, data: { pdfPath, pdfGeneratedAt: new Date() } });

  return {
    pdfBuffer,
    pdfPath,
    fileName: buildPayslipFileName(payslip.employee.fullName, payslip.payrollRun.month, payslip.payrollRun.year),
    employeeEmail: payslip.employee.email,
    employeeName: payslip.employee.fullName,
    month: payslip.payrollRun.month,
    year: payslip.payrollRun.year,
  };
};

// The employee-self-or-admin single-PDF download route's lookup — reads the
// already-generated file when there is one, otherwise generates it inline
// (the safety net for a queue job that hasn't run yet or failed).
export const getEmployeePayslipPdfPath = async (
  prisma: PrismaClient,
  params: { organizationId: string; employeeId: string; payslipId: string; requestingEmployeeId: string; requestingRole: EmployeeRole },
): Promise<{ absolutePath: string; fileName: string }> => {
  const { organizationId, employeeId, payslipId, requestingEmployeeId, requestingRole } = params;
  assertCanViewEmployeeResource(requestingRole, requestingEmployeeId, employeeId);

  const payslip = await prisma.payslip.findFirst({
    where: { id: payslipId, employeeId, payrollRun: { organizationId } },
    select: { pdfPath: true, employee: { select: { fullName: true } }, payrollRun: { select: { month: true, year: true, status: true } } },
  });
  if (!payslip) {
    throw new AppError(404, "NOT_FOUND", "Payslip not found");
  }
  if (payslip.payrollRun.status !== "APPROVED" && payslip.payrollRun.status !== "PAID") {
    throw new AppError(403, "FORBIDDEN", "This payslip is not available yet");
  }

  const fileName = buildPayslipFileName(payslip.employee.fullName, payslip.payrollRun.month, payslip.payrollRun.year);
  if (payslip.pdfPath) {
    return { absolutePath: getAbsolutePdfPath(payslip.pdfPath), fileName };
  }

  const generated = await generateAndStorePayslipPdf(prisma, { organizationId, payslipId });
  return { absolutePath: getAbsolutePdfPath(generated.pdfPath), fileName: generated.fileName };
};

// Admin bulk-download's lookup — one absolute path + display filename per
// payslip in the run, generating on the fly for any still missing a PDF.
// Sequential, not Promise.all: a run can have hundreds of payslips, and this
// is the fallback path (the queue should already have generated most of
// these after approval) — no reason to burst that many PDF generations at once.
export const getPayslipPdfPathsForRun = async (
  prisma: PrismaClient,
  params: { organizationId: string; runId: string },
): Promise<{ month: number; year: number; files: Array<{ absolutePath: string; fileName: string }> }> => {
  const { organizationId, runId } = params;
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, organizationId } });
  if (!run) {
    throw new AppError(404, "NOT_FOUND", "Payroll run not found");
  }
  if (run.status !== "APPROVED" && run.status !== "PAID") {
    throw new AppError(409, "CONFLICT", "Payslip PDFs are only available for an APPROVED or PAID run");
  }

  const payslips = await prisma.payslip.findMany({
    where: { payrollRunId: runId },
    select: { id: true, pdfPath: true, employee: { select: { fullName: true } } },
  });

  const files: Array<{ absolutePath: string; fileName: string }> = [];
  for (const payslip of payslips) {
    if (payslip.pdfPath) {
      files.push({ absolutePath: getAbsolutePdfPath(payslip.pdfPath), fileName: buildPayslipFileName(payslip.employee.fullName, run.month, run.year) });
    } else {
      const generated = await generateAndStorePayslipPdf(prisma, { organizationId, payslipId: payslip.id });
      files.push({ absolutePath: getAbsolutePdfPath(generated.pdfPath), fileName: generated.fileName });
    }
  }
  return { month: run.month, year: run.year, files };
};
