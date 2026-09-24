import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../core/prisma.js";
import { EmployeeRole, ExpenseStatus } from "../../generated/prisma/client.js";
import { AppError } from "../../core/errors.js";
import { ok } from "../../core/response.js";
import { currencyCodeSchema } from "../currency/currencies.js";
import {
  adminApproveExpenseRequest,
  adminRejectExpenseRequest,
  cancelExpenseRequest,
  createExpenseRequest,
  expenseRequestInclude,
  initiateExpensePayment,
  managerApproveExpenseRequest,
  managerRejectExpenseRequest,
} from "./expenseRequests.service.js";

const ADMIN_ROLES = [EmployeeRole.ADMIN];

const idParamSchema = z.object({ id: z.string().min(1) });

// expenseDate: z.coerce.date() on "YYYY-MM-DD" parses as UTC midnight, which
// is exactly what the @db.Date column stores — same convention as the holiday
// and leave routes. A future date is rejected here (you can't have already
// spent money tomorrow); how far back is allowed is a policy question we
// don't have an answer for yet, so the past is open.
const createExpenseRequestSchema = z.object({
  expenseTypeId: z.string().min(1),
  approverManagerId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000).optional(),
  expenseDate: z.coerce.date().refine((date) => date.getTime() <= Date.now(), {
    message: "expenseDate cannot be in the future",
  }),
  amount: z.number().positive(),
  currency: currencyCodeSchema,
});

const listMineQuerySchema = z.object({ status: z.enum(ExpenseStatus).optional() });

const decisionBodySchema = z.object({
  decisionNote: z.string().trim().min(1).max(500).optional(),
});

export const expenseRequestRoutes = async (app: FastifyInstance) => {
  // Populates the "Reporting Manager" dropdown on the raise-expense form —
  // "an approver" is defined as anyone in the org who appears as someone
  // else's Employee.managerId, i.e. they have at least one report. This is
  // deliberately not restricted to the raiser's own manager or to ADMINs:
  // any manager in the org can be picked as the reviewer for a given expense.
  app.get("/expenses/approvers", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId } = request.auth;

    const managersWithReports = await prisma.employee.findMany({
      where: { organizationId, managerId: { not: null } },
      select: { managerId: true },
      distinct: ["managerId"],
    });
    const managerIds = managersWithReports
      .map((row) => row.managerId)
      .filter((managerId): managerId is string => managerId !== null);

    const approvers = await prisma.employee.findMany({
      where: { id: { in: managerIds }, organizationId },
      select: { id: true, fullName: true, designation: true },
      orderBy: { fullName: "asc" },
    });

    return ok({ approvers });
  });

  app.post("/expenses", { preHandler: app.requireAuth }, async (request, reply) => {
    const { organizationId, employeeId } = request.auth;
    const body = createExpenseRequestSchema.parse(request.body);

    const expenseRequest = await createExpenseRequest(prisma, { organizationId, employeeId, ...body });

    reply.status(201);
    return ok({ expenseRequest });
  });

  app.get("/expenses/me", { preHandler: app.requireAuth }, async (request) => {
    const { employeeId } = request.auth;
    const { status } = listMineQuerySchema.parse(request.query);

    const expenseRequests = await prisma.expenseRequest.findMany({
      where: { employeeId, ...(status ? { status } : {}) },
      include: expenseRequestInclude,
      orderBy: { createdAt: "desc" },
    });

    return ok({ expenseRequests });
  });

  // Visible to the raiser, the named approving manager, or any ADMIN in the
  // org — same-org cross-tenant access is a 404, not a 403, so a foreign id
  // never confirms a request exists in another org.
  app.get("/expenses/:id", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId, employeeId, role } = request.auth;
    const { id } = idParamSchema.parse(request.params);

    const expenseRequest = await prisma.expenseRequest.findFirst({
      where: { id, organizationId },
      include: { ...expenseRequestInclude, attachments: true },
    });
    if (!expenseRequest) {
      throw new AppError(404, "NOT_FOUND", "Expense request not found");
    }

    const canView =
      expenseRequest.employeeId === employeeId ||
      expenseRequest.approverManagerId === employeeId ||
      role === EmployeeRole.ADMIN;
    if (!canView) {
      throw new AppError(403, "FORBIDDEN", "Forbidden");
    }

    return ok({ expenseRequest });
  });

  app.post("/expenses/:id/cancel", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId, employeeId } = request.auth;
    const { id } = idParamSchema.parse(request.params);

    const expenseRequest = await cancelExpenseRequest(prisma, { id, organizationId, employeeId });
    return ok({ expenseRequest });
  });

  // Manager stage — gated by "am I the named approverManagerId", not by
  // role, so requireAuth (not requireRole) is correct here.
  app.get("/expenses/pending-manager", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId, employeeId } = request.auth;

    const expenseRequests = await prisma.expenseRequest.findMany({
      where: { organizationId, approverManagerId: employeeId, status: ExpenseStatus.PENDING_MANAGER },
      include: expenseRequestInclude,
      orderBy: { createdAt: "asc" },
    });

    return ok({ expenseRequests });
  });

  app.post("/expenses/:id/manager-approve", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId, employeeId: approverEmployeeId } = request.auth;
    const { id } = idParamSchema.parse(request.params);
    const { decisionNote } = decisionBodySchema.parse(request.body ?? {});

    const expenseRequest = await managerApproveExpenseRequest(prisma, {
      id,
      organizationId,
      approverEmployeeId,
      decisionNote,
    });
    return ok({ expenseRequest });
  });

  app.post("/expenses/:id/manager-reject", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId, employeeId: approverEmployeeId } = request.auth;
    const { id } = idParamSchema.parse(request.params);
    const { decisionNote } = decisionBodySchema.parse(request.body ?? {});

    const expenseRequest = await managerRejectExpenseRequest(prisma, {
      id,
      organizationId,
      approverEmployeeId,
      decisionNote,
    });
    return ok({ expenseRequest });
  });

  // Admin stage.
  app.get("/expenses/pending-admin", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;

    const expenseRequests = await prisma.expenseRequest.findMany({
      where: { organizationId, status: ExpenseStatus.PENDING_ADMIN },
      include: expenseRequestInclude,
      orderBy: { createdAt: "asc" },
    });

    return ok({ expenseRequests });
  });

  app.post("/expenses/:id/admin-approve", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId, employeeId: adminEmployeeId } = request.auth;
    const { id } = idParamSchema.parse(request.params);
    const { decisionNote } = decisionBodySchema.parse(request.body ?? {});

    const expenseRequest = await adminApproveExpenseRequest(prisma, {
      id,
      organizationId,
      adminEmployeeId,
      decisionNote,
    });
    return ok({ expenseRequest });
  });

  app.post("/expenses/:id/admin-reject", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId, employeeId: adminEmployeeId } = request.auth;
    const { id } = idParamSchema.parse(request.params);
    const { decisionNote } = decisionBodySchema.parse(request.body ?? {});

    const expenseRequest = await adminRejectExpenseRequest(prisma, {
      id,
      organizationId,
      adminEmployeeId,
      decisionNote,
    });
    return ok({ expenseRequest });
  });

  app.get("/expenses/approved", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;

    const expenseRequests = await prisma.expenseRequest.findMany({
      where: { organizationId, status: ExpenseStatus.APPROVED },
      include: expenseRequestInclude,
      orderBy: { adminDecidedAt: "asc" },
    });

    return ok({ expenseRequests });
  });

  // TODO(finance-department): ADMIN-gated for now. Once Department carries a
  // "this is Finance" marker, swap/extend this preHandler to check the
  // caller's departmentId instead of (or alongside) role — do NOT add a new
  // EmployeeRole for it. initiateExpensePayment itself is already agnostic
  // to who's calling, so only this line needs to change.
  app.post("/expenses/:id/initiate-payment", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId, employeeId: initiatedById } = request.auth;
    const { id } = idParamSchema.parse(request.params);

    const expenseRequest = await initiateExpensePayment(prisma, { id, organizationId, initiatedById });
    return ok({ expenseRequest });
  });
};
