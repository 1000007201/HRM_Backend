import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../core/prisma.js";
import { EmployeeRole, Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../core/errors.js";
import { ok } from "../../core/response.js";
import { accrueForOrg } from "./accrual.js";
import { grantAnnualForOrg } from "./floaterGrant.js";
import { createLeaveType, leaveTypeSelect, updateFloaterQuota } from "./leaveTypes.js";

const ADMIN_ROLES = [EmployeeRole.ADMIN];

const employeeIdParamSchema = z.object({ employeeId: z.string().min(1) });

const accrualRunBodySchema = z.object({
  year: z.number().int().min(2000).max(2100).optional(),
  month: z.number().int().min(1).max(12).optional(),
});

const grantRunBodySchema = z.object({
  year: z.number().int().min(2000).max(2100).optional(),
});

const updateFloaterQuotaSchema = z.object({
  annualGrantDays: z.number().int().min(1).max(365),
});

const createLeaveTypeSchema = z.object({
  name: z.string().trim().min(1).max(200),
  code: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[A-Z0-9_]+$/, "Use uppercase letters, numbers, and underscores only"),
  annualCap: z.number().int().min(1).max(365),
  accrualFrequency: z.enum(["ANNUAL", "MONTHLY"]),
  isPaid: z.boolean().default(true),
  allowHalfDay: z.boolean().default(true),
});

// Every active leave type for the org, joined in memory with any existing
// LeaveBalance row for (employee, year) — a type with no row yet (accrual
// hasn't run this year) still shows up, at zero, instead of being omitted.
const getEmployeeLeaveBalances = async (organizationId: string, employeeId: string, year: number) => {
  const [leaveTypes, balances] = await Promise.all([
    prisma.leaveType.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" } }),
    prisma.leaveBalance.findMany({ where: { organizationId, employeeId, year } }),
  ]);

  const balanceByLeaveTypeId = new Map(balances.map((balance) => [balance.leaveTypeId, balance]));
  const zero = new Prisma.Decimal(0);

  return leaveTypes.map((leaveType) => {
    const balance = balanceByLeaveTypeId.get(leaveType.id);
    const accruedDays = balance?.accruedDays ?? zero;
    const usedDays = balance?.usedDays ?? zero;
    return {
      leaveTypeId: leaveType.id,
      code: leaveType.code,
      name: leaveType.name,
      accruedDays,
      usedDays,
      availableDays: accruedDays.minus(usedDays),
    };
  });
};

export const leaveRoutes = async (app: FastifyInstance) => {
  app.get("/leave/types", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId } = request.auth;

    const leaveTypes = await prisma.leaveType.findMany({
      where: { organizationId, isActive: true },
      select: leaveTypeSelect,
      orderBy: { code: "asc" },
    });

    return ok({ leaveTypes });
  });

  // A duplicate code hits the organizationId_code unique constraint and is
  // mapped to 409 CONFLICT centrally (see registerErrorHandler) — no
  // pre-check needed, same as POST /holidays.
  //
  // Runs accrual for the current month right away instead of waiting for the
  // next scheduler tick (accrualScheduler.ts, up to 24h later) — every
  // eligible employee gets this new type's first month credited immediately,
  // mid-month included, not just employees who join after it exists.
  app.post("/leave/types", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const { organizationId } = request.auth;
    const body = createLeaveTypeSchema.parse(request.body);

    const leaveType = await createLeaveType({ organizationId, ...body });
    const now = new Date();
    await accrueForOrg(organizationId, now.getFullYear(), now.getMonth() + 1);

    reply.status(201);
    return ok({ leaveType });
  });

  app.get("/leave/balances/me", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId, employeeId } = request.auth;
    const year = new Date().getFullYear();

    const balances = await getEmployeeLeaveBalances(organizationId, employeeId, year);
    return ok({ year, balances });
  });

  app.get("/leave/balances/:employeeId", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { employeeId } = employeeIdParamSchema.parse(request.params);

    const employee = await prisma.employee.findFirst({ where: { id: employeeId, organizationId }, select: { id: true } });
    if (!employee) {
      throw new AppError(404, "NOT_FOUND", "Employee not found");
    }

    const year = new Date().getFullYear();
    const balances = await getEmployeeLeaveBalances(organizationId, employeeId, year);
    return ok({ year, balances });
  });

  // ADMIN only (not HR) — this credits real balances, so it's kept narrower
  // than the HR-inclusive read/CRUD gate used elsewhere.
  app.post("/admin/leave/accrual/run", { preHandler: app.requireRole([EmployeeRole.ADMIN]) }, async (request) => {
    const { organizationId } = request.auth;
    const now = new Date();
    const { year = now.getFullYear(), month = now.getMonth() + 1 } = accrualRunBodySchema.parse(request.body ?? {});

    const result = await accrueForOrg(organizationId, year, month);
    return ok(result);
  });

  // ADMIN only, parallel to /admin/leave/accrual/run — manual/testing trigger
  // for the annual floater grant (floaterGrant.ts), which otherwise only runs
  // via the shared-secret system endpoint / scheduler.
  app.post("/admin/leave/floater/grant", { preHandler: app.requireRole([EmployeeRole.ADMIN]) }, async (request) => {
    const { organizationId } = request.auth;
    const { year = new Date().getFullYear() } = grantRunBodySchema.parse(request.body ?? {});

    const result = await grantAnnualForOrg(organizationId, year);
    return ok(result);
  });

  // ADMIN only — lets the org configure how many floater leaves an employee
  // can take a year (previously fixed at 2 for every org at seed time).
  // Applies immediately to everyone already granted this year, not just
  // future grants — see the updateFloaterQuota comment for why.
  app.patch("/admin/leave/floater/quota", { preHandler: app.requireRole([EmployeeRole.ADMIN]) }, async (request) => {
    const { organizationId } = request.auth;
    const { annualGrantDays } = updateFloaterQuotaSchema.parse(request.body);

    const leaveType = await updateFloaterQuota(organizationId, annualGrantDays);
    return ok({ leaveType });
  });
};
