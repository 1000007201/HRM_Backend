import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../core/errors.js";
import { computePayroll } from "./engine.js";
import { computeLopAndPaidDays } from "./lopDays.js";
import { getYtdFigures } from "./ytd.js";
import { financialYearFor, monthsRemainingInFy } from "./taxSlabs.js";
import { getOrCreatePayrollSettings } from "./payrollSettings.service.js";

const PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;
// Hundreds of employees in one transaction — Prisma's default 5s interactive
// transaction timeout is nowhere near enough.
const PROCESS_TRANSACTION_TIMEOUT_MS = 5 * 60 * 1000;

export interface CreatePayrollRunParams {
  organizationId: string;
  month: number;
  year: number;
}

export const createPayrollRun = async (prisma: PrismaClient, params: CreatePayrollRunParams) => {
  const { organizationId, month, year } = params;
  if (month < 1 || month > 12) {
    throw new AppError(400, "VALIDATION", "month must be between 1 and 12");
  }

  const periodStart = new Date(Date.UTC(year, month - 1, 1));
  if (periodStart > new Date()) {
    throw new AppError(400, "VALIDATION", "Cannot create a payroll run for a future month");
  }

  // The actual guarantee is the DB's partial unique index (see the
  // PayrollRun schema comment) — a concurrent duplicate create still gets a
  // clean 409 via the P2002 mapping in errorHandler.ts. This is just a
  // friendlier message for the common non-race path.
  const existing = await prisma.payrollRun.findFirst({ where: { organizationId, month, year, status: { not: "CANCELLED" } } });
  if (existing) {
    throw new AppError(409, "CONFLICT", "A payroll run already exists for this month");
  }

  return prisma.payrollRun.create({ data: { organizationId, month, year, status: "DRAFT" } });
};

export const listPayrollRuns = async (
  prisma: PrismaClient,
  params: { organizationId: string; page: number; pageSize: number },
) => {
  const { organizationId, page, pageSize } = params;
  const [payrollRuns, total] = await Promise.all([
    prisma.payrollRun.findMany({
      where: { organizationId },
      orderBy: [{ year: "desc" }, { month: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { _count: { select: { payslips: true } } },
    }),
    prisma.payrollRun.count({ where: { organizationId } }),
  ]);
  return { payrollRuns, page, pageSize, total };
};

export const getPayrollRun = async (prisma: PrismaClient, params: { organizationId: string; runId: string }) => {
  const { organizationId, runId } = params;
  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, organizationId },
    include: { _count: { select: { payslips: true } } },
  });
  if (!run) {
    throw new AppError(404, "NOT_FOUND", "Payroll run not found");
  }
  return run;
};

// Shared by both /process and /reprocess — reprocessing IS processing, just
// re-triggered from REVIEW instead of DRAFT. Wipes and regenerates every
// payslip/component for the run rather than diffing, so it can never mix
// stale and fresh lines.
export const processPayrollRun = async (prisma: PrismaClient, params: { organizationId: string; runId: string }) => {
  const { organizationId, runId } = params;

  const run = await prisma.payrollRun.findFirst({ where: { id: runId, organizationId } });
  if (!run) {
    throw new AppError(404, "NOT_FOUND", "Payroll run not found");
  }

  const stuckProcessing = run.status === "PROCESSING" && Date.now() - run.updatedAt.getTime() > PROCESSING_TIMEOUT_MS;
  const canProcess = run.status === "DRAFT" || run.status === "REVIEW" || stuckProcessing;
  if (!canProcess) {
    throw new AppError(409, "CONFLICT", "Only a DRAFT or REVIEW run can be processed (a stuck PROCESSING run frees up after 10 minutes)");
  }

  // Optimistic lock: flip to PROCESSING only if it's still in the state we
  // just read. A concurrent trigger loses this race and fails cleanly
  // instead of double-processing the same run.
  const locked = await prisma.payrollRun.updateMany({ where: { id: runId, status: run.status }, data: { status: "PROCESSING" } });
  if (locked.count === 0) {
    throw new AppError(409, "CONFLICT", "This run is already being processed");
  }

  try {
    const settings = await getOrCreatePayrollSettings(prisma, { organizationId });
    const employees = await prisma.employee.findMany({ where: { organizationId, isActive: true } });
    const financialYear = financialYearFor(run.month, run.year);
    const monthsRemaining = monthsRemainingInFy(run.month);

    return await prisma.$transaction(
      async (tx) => {
        let totalGross = new Prisma.Decimal(0);
        let totalDeductions = new Prisma.Decimal(0);
        let totalNet = new Prisma.Decimal(0);
        let totalEmployerCost = new Prisma.Decimal(0);

        for (const employee of employees) {
          const structure = await tx.salaryStructure.findFirst({
            where: { employeeId: employee.id, effectiveTo: null },
            include: { components: { include: { component: true } } },
          });
          if (!structure) {
            throw new AppError(400, "VALIDATION", `${employee.fullName} has no active salary structure`);
          }

          const earningComponents = structure.components.filter((c) => c.component.componentType === "EARNING");
          if (settings.pfEnabled && !earningComponents.some((c) => c.component.code.toUpperCase() === "BASIC")) {
            throw new AppError(400, "VALIDATION", `${employee.fullName}'s salary structure has no component coded "BASIC", required for PF`);
          }

          const { daysInMonth, lopDays, paidDays } = await computeLopAndPaidDays(tx, {
            organizationId,
            employeeId: employee.id,
            month: run.month,
            year: run.year,
            lopBasis: settings.lopBasis,
          });

          const taxDeclaration = await tx.employeeTaxDeclaration.findUnique({
            where: { employeeId_financialYear: { employeeId: employee.id, financialYear } },
          });
          const { ytdEarnings, ytdTdsDeducted } = await getYtdFigures(tx, {
            organizationId,
            employeeId: employee.id,
            month: run.month,
            year: run.year,
          });

          const output = computePayroll({
            employee: {
              id: employee.id,
              salaryComponents: earningComponents.map((c) => ({
                componentId: c.componentId,
                code: c.component.code,
                name: c.component.name,
                componentType: c.component.componentType,
                monthlyAmount: c.monthlyAmount.toNumber(),
              })),
            },
            period: { month: run.month, year: run.year, daysInMonth },
            lopDays,
            settings: {
              pfEnabled: settings.pfEnabled,
              pfCeiling: settings.pfCeiling,
              esiEnabled: settings.esiEnabled,
              ptEnabled: settings.ptEnabled,
              ptState: settings.ptState,
            },
            taxDeclaration: taxDeclaration && {
              regime: taxDeclaration.regime,
              previousEmployerIncome: taxDeclaration.previousEmployerIncome?.toNumber() ?? 0,
              previousEmployerTds: taxDeclaration.previousEmployerTds?.toNumber() ?? 0,
              section80C: taxDeclaration.section80C?.toNumber() ?? 0,
              section80D: taxDeclaration.section80D?.toNumber() ?? 0,
              hraExemption: taxDeclaration.hraExemption?.toNumber() ?? 0,
              otherDeductions: taxDeclaration.otherDeductions?.toNumber() ?? 0,
            },
            ytdEarnings,
            ytdTdsDeducted,
            monthsRemainingInFy: monthsRemaining,
          });

          const payslip = await tx.payslip.upsert({
            where: { payrollRunId_employeeId: { payrollRunId: runId, employeeId: employee.id } },
            create: {
              payrollRunId: runId,
              employeeId: employee.id,
              daysInMonth,
              lopDays,
              paidDays: output.paidDays,
              grossEarnings: output.grossEarnings,
              totalDeductions: output.totalDeductions,
              netPay: output.netPay,
              employerCost: output.employerCost,
            },
            update: {
              daysInMonth,
              lopDays,
              paidDays: output.paidDays,
              grossEarnings: output.grossEarnings,
              totalDeductions: output.totalDeductions,
              netPay: output.netPay,
              employerCost: output.employerCost,
              // A reprocess can change every number on the payslip — clear
              // the old PDF pointer so a stale one is never served; the next
              // download (or the queue's batch trigger) regenerates it.
              pdfPath: null,
              pdfGeneratedAt: null,
            },
          });

          await tx.payslipComponent.deleteMany({ where: { payslipId: payslip.id } });
          await tx.payslipComponent.createMany({
            data: output.components.map((component) => ({
              payslipId: payslip.id,
              componentId: component.componentId,
              name: component.name,
              componentType: component.componentType,
              amount: component.amount,
            })),
          });

          totalGross = totalGross.plus(output.grossEarnings);
          totalDeductions = totalDeductions.plus(output.totalDeductions);
          totalNet = totalNet.plus(output.netPay);
          totalEmployerCost = totalEmployerCost.plus(output.employerCost);
        }

        return tx.payrollRun.update({
          where: { id: runId },
          data: { status: "REVIEW", processedAt: new Date(), totalGross, totalDeductions, totalNet, totalEmployerCost },
        });
      },
      { timeout: PROCESS_TRANSACTION_TIMEOUT_MS },
    );
  } catch (error) {
    // Roll the lock back so the admin can retry immediately instead of
    // waiting out the 10-minute stuck-PROCESSING timeout. The transaction
    // itself already rolled back — no partial payslips were left behind.
    await prisma.payrollRun.update({ where: { id: runId }, data: { status: "DRAFT" } }).catch(() => {});
    throw error;
  }
};

export const approvePayrollRun = async (
  prisma: PrismaClient,
  params: { organizationId: string; runId: string; approvedByEmployeeId: string },
) => {
  const { organizationId, runId, approvedByEmployeeId } = params;
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, organizationId } });
  if (!run) {
    throw new AppError(404, "NOT_FOUND", "Payroll run not found");
  }
  if (run.status !== "REVIEW") {
    throw new AppError(409, "CONFLICT", "Only a REVIEW run can be approved");
  }

  const updated = await prisma.payrollRun.updateMany({
    where: { id: runId, status: "REVIEW" },
    data: { status: "APPROVED", approvedAt: new Date(), approvedById: approvedByEmployeeId },
  });
  if (updated.count === 0) {
    throw new AppError(409, "CONFLICT", "Only a REVIEW run can be approved");
  }
  return prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } });
};

export const markPayrollRunPaid = async (prisma: PrismaClient, params: { organizationId: string; runId: string }) => {
  const { organizationId, runId } = params;
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, organizationId } });
  if (!run) {
    throw new AppError(404, "NOT_FOUND", "Payroll run not found");
  }
  if (run.status !== "APPROVED") {
    throw new AppError(409, "CONFLICT", "Only an APPROVED run can be marked paid");
  }

  const updated = await prisma.payrollRun.updateMany({ where: { id: runId, status: "APPROVED" }, data: { status: "PAID", paidAt: new Date() } });
  if (updated.count === 0) {
    throw new AppError(409, "CONFLICT", "Only an APPROVED run can be marked paid");
  }
  return prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } });
};

export const cancelPayrollRun = async (prisma: PrismaClient, params: { organizationId: string; runId: string }) => {
  const { organizationId, runId } = params;
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, organizationId } });
  if (!run) {
    throw new AppError(404, "NOT_FOUND", "Payroll run not found");
  }
  if (run.status !== "DRAFT" && run.status !== "REVIEW") {
    throw new AppError(409, "CONFLICT", "Only a DRAFT or REVIEW run can be cancelled");
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.payrollRun.updateMany({ where: { id: runId, status: run.status }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    if (updated.count === 0) {
      throw new AppError(409, "CONFLICT", "Only a DRAFT or REVIEW run can be cancelled");
    }
    // PayslipComponent cascades from Payslip — see schema.prisma.
    await tx.payslip.deleteMany({ where: { payrollRunId: runId } });
    return tx.payrollRun.findUniqueOrThrow({ where: { id: runId } });
  });
};
