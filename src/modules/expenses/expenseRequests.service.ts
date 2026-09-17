import { Prisma, ExpenseStatus, type PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../core/errors.js";
import { convertToInr } from "../currency/exchangeRates.service.js";
import type { CurrencyCode } from "../currency/currencies.js";

// Business operations for the expense-reimbursement lifecycle. Routes parse
// input, authorize, and call one of these — see the ExpenseStatus comment in
// schema.prisma for the full state diagram.

export const expenseRequestInclude = {
  employee: { select: { id: true, fullName: true } },
  approverManager: { select: { id: true, fullName: true } },
  expenseType: { select: { id: true, name: true } },
} as const;

export interface CreateExpenseRequestParams {
  organizationId: string;
  employeeId: string;
  expenseTypeId: string;
  approverManagerId: string;
  title: string;
  description?: string;
  amount: number;
  currency: CurrencyCode;
}

// "A valid approver" is any employee in the org who has at least one report
// (Employee.managerId pointing at them) — same definition GET
// /expenses/approvers uses to populate the dropdown in the first place, so a
// client can't submit an approverManagerId the dropdown wouldn't have
// offered. It is deliberately NOT Employee.managerId (the raiser's actual
// manager) — the caller picks who reviews this specific expense.
const assertValidApprover = async (
  prisma: PrismaClient,
  organizationId: string,
  approverManagerId: string,
  raiserEmployeeId: string,
): Promise<void> => {
  if (approverManagerId === raiserEmployeeId) {
    throw new AppError(400, "VALIDATION", "You cannot select yourself as the approving manager");
  }

  const approver = await prisma.employee.findFirst({ where: { id: approverManagerId, organizationId } });
  if (!approver) {
    throw new AppError(400, "VALIDATION", "approverManagerId must reference an employee in your organization");
  }

  const hasReports = await prisma.employee.count({ where: { organizationId, managerId: approverManagerId } });
  if (hasReports === 0) {
    throw new AppError(400, "VALIDATION", "approverManagerId must be an employee who has reports");
  }
};

export const createExpenseRequest = async (prisma: PrismaClient, params: CreateExpenseRequestParams) => {
  const { organizationId, employeeId, expenseTypeId, approverManagerId, title, description, amount, currency } =
    params;

  const expenseType = await prisma.expenseType.findFirst({
    where: { id: expenseTypeId, organizationId, isActive: true },
  });
  if (!expenseType) {
    throw new AppError(400, "VALIDATION", "expenseTypeId must reference an active expense type in your organization");
  }

  await assertValidApprover(prisma, organizationId, approverManagerId, employeeId);

  // Frozen here, never recomputed — see the model comment in schema.prisma.
  const { amountInInr, inrPerUnit, rateDate } = await convertToInr(prisma, amount, currency);

  return prisma.expenseRequest.create({
    data: {
      organizationId,
      employeeId,
      approverManagerId,
      expenseTypeId,
      title,
      description,
      amount: new Prisma.Decimal(amount),
      currency,
      exchangeRate: inrPerUnit,
      amountInInr,
      rateDate,
    },
    include: expenseRequestInclude,
  });
};

// A pending request never had any downstream effect, so cancelling is a
// plain status flip — no balance/ledger to unwind, unlike leave.
export const cancelExpenseRequest = async (
  prisma: PrismaClient,
  params: { id: string; organizationId: string; employeeId: string },
) => {
  const { id, organizationId, employeeId } = params;

  const { count } = await prisma.expenseRequest.updateMany({
    where: { id, organizationId, employeeId, status: ExpenseStatus.PENDING_MANAGER },
    data: { status: ExpenseStatus.CANCELLED },
  });
  if (count === 0) {
    const existing = await prisma.expenseRequest.findFirst({ where: { id, organizationId, employeeId } });
    if (!existing) {
      throw new AppError(404, "NOT_FOUND", "Expense request not found");
    }
    throw new AppError(409, "CONFLICT", "Only a request awaiting manager approval can be cancelled");
  }

  return prisma.expenseRequest.findUniqueOrThrow({ where: { id }, include: expenseRequestInclude });
};

export interface DecideAsManagerParams {
  id: string;
  organizationId: string;
  approverEmployeeId: string;
  decisionNote?: string;
}

// Gated by "are you the named approverManagerId on this specific request",
// not by role — any employee with reports can act here once they're named on
// something. Re-checks status inside the transaction so two concurrent
// decisions (or a decision racing a cancel) can't both apply.
export const managerApproveExpenseRequest = async (prisma: PrismaClient, params: DecideAsManagerParams) => {
  const { id, organizationId, approverEmployeeId, decisionNote } = params;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.expenseRequest.findFirst({ where: { id, organizationId } });
    if (!existing) {
      throw new AppError(404, "NOT_FOUND", "Expense request not found");
    }
    if (existing.approverManagerId !== approverEmployeeId) {
      throw new AppError(403, "FORBIDDEN", "You are not the approving manager for this request");
    }
    // Re-guard: create-time validation already blocks approverManagerId ===
    // employeeId, but nothing stops the raiser's manager assignment from
    // changing later — never trust the earlier check alone at decision time.
    if (existing.employeeId === approverEmployeeId) {
      throw new AppError(403, "FORBIDDEN", "You cannot approve your own expense");
    }
    if (existing.status !== ExpenseStatus.PENDING_MANAGER) {
      throw new AppError(409, "CONFLICT", "This request is not awaiting manager approval");
    }

    return tx.expenseRequest.update({
      where: { id },
      data: { status: ExpenseStatus.PENDING_ADMIN, managerDecidedAt: new Date(), managerDecisionNote: decisionNote },
      include: expenseRequestInclude,
    });
  });
};

export const managerRejectExpenseRequest = async (prisma: PrismaClient, params: DecideAsManagerParams) => {
  const { id, organizationId, approverEmployeeId, decisionNote } = params;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.expenseRequest.findFirst({ where: { id, organizationId } });
    if (!existing) {
      throw new AppError(404, "NOT_FOUND", "Expense request not found");
    }
    if (existing.approverManagerId !== approverEmployeeId) {
      throw new AppError(403, "FORBIDDEN", "You are not the approving manager for this request");
    }
    if (existing.status !== ExpenseStatus.PENDING_MANAGER) {
      throw new AppError(409, "CONFLICT", "This request is not awaiting manager approval");
    }

    return tx.expenseRequest.update({
      where: { id },
      data: { status: ExpenseStatus.REJECTED, managerDecidedAt: new Date(), managerDecisionNote: decisionNote },
      include: expenseRequestInclude,
    });
  });
};

export interface DecideAsAdminParams {
  id: string;
  organizationId: string;
  adminEmployeeId: string;
  decisionNote?: string;
}

// requireRole(ADMIN) at the route already restricts who can call this.
// Deliberately NO self-approval guard at this stage (unlike manager-approve,
// where it's structural — approverManagerId can never equal the raiser, see
// assertValidApprover): an org can have exactly one ADMIN, and that admin's
// own expenses still need a path to payment after clearing manager review.
// Blocking self-approval here would permanently deadlock a single-admin org
// instead of just adding friction. Self-review already happened one stage
// earlier, by a different person (the named approverManagerId).
export const adminApproveExpenseRequest = async (prisma: PrismaClient, params: DecideAsAdminParams) => {
  const { id, organizationId, adminEmployeeId, decisionNote } = params;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.expenseRequest.findFirst({ where: { id, organizationId } });
    if (!existing) {
      throw new AppError(404, "NOT_FOUND", "Expense request not found");
    }
    if (existing.status !== ExpenseStatus.PENDING_ADMIN) {
      throw new AppError(409, "CONFLICT", "This request is not awaiting admin approval");
    }

    return tx.expenseRequest.update({
      where: { id },
      data: {
        status: ExpenseStatus.APPROVED,
        adminDecidedById: adminEmployeeId,
        adminDecidedAt: new Date(),
        adminDecisionNote: decisionNote,
      },
      include: expenseRequestInclude,
    });
  });
};

export const adminRejectExpenseRequest = async (prisma: PrismaClient, params: DecideAsAdminParams) => {
  const { id, organizationId, adminEmployeeId, decisionNote } = params;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.expenseRequest.findFirst({ where: { id, organizationId } });
    if (!existing) {
      throw new AppError(404, "NOT_FOUND", "Expense request not found");
    }
    if (existing.status !== ExpenseStatus.PENDING_ADMIN) {
      throw new AppError(409, "CONFLICT", "This request is not awaiting admin approval");
    }

    return tx.expenseRequest.update({
      where: { id },
      data: {
        status: ExpenseStatus.REJECTED,
        adminDecidedById: adminEmployeeId,
        adminDecidedAt: new Date(),
        adminDecisionNote: decisionNote,
      },
      include: expenseRequestInclude,
    });
  });
};

// TODO(finance-department): currently ADMIN-gated at the route
// (requireRole([EmployeeRole.ADMIN])) as a placeholder for "whoever handles
// payouts". Once Department carries a "this is the Finance department"
// marker, gate this on the caller's departmentId instead of (or alongside)
// ADMIN — do NOT add a new EmployeeRole for it. This function itself doesn't
// care who's calling; only the route's preHandler needs to change.
export const initiateExpensePayment = async (
  prisma: PrismaClient,
  params: { id: string; organizationId: string; initiatedById: string },
) => {
  const { id, organizationId, initiatedById } = params;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.expenseRequest.findFirst({ where: { id, organizationId } });
    if (!existing) {
      throw new AppError(404, "NOT_FOUND", "Expense request not found");
    }
    if (existing.status !== ExpenseStatus.APPROVED) {
      throw new AppError(409, "CONFLICT", "Only an approved request can have payment initiated");
    }

    return tx.expenseRequest.update({
      where: { id },
      data: { status: ExpenseStatus.PAYMENT_INITIATED, paymentInitiatedById: initiatedById, paymentInitiatedAt: new Date() },
      include: expenseRequestInclude,
    });
  });
};
