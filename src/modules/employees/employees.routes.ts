import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../core/prisma.js";
import { EmployeeRole } from "../../generated/prisma/client.js";
import { AppError } from "../../core/errors.js";
import { ok } from "../../core/response.js";
import { buildOrgChartTree } from "./orgChart.js";

const employeeIncludes = {
  manager: { select: { id: true, fullName: true } },
  department: { select: { id: true, name: true } },
} as const;
// ADMIN is the only role left with elevated permissions, so it's the only
// gate left too — see the EmployeeRole reduction (was ADMIN/HR/MANAGER/EMPLOYEE).
const ADMIN_ROLES = [EmployeeRole.ADMIN];

// Lightweight, non-sensitive projection used by both org-chart endpoints —
// no email, no organizationId, nothing beyond what's needed to render a tree.
const lightweightEmployeeSelect = {
  id: true,
  fullName: true,
  role: true,
  designation: true,
  userId: true,
} as const;

// Excludes the optional HR profile fields (phone, dateOfBirth, gender,
// address, emergency contacts, employeeCode) to keep the list payload lean —
// those are fetched via the detail endpoint only. joiningDate/leavingDate
// stay in, since they're core lifecycle fields shown as list columns.
const employeeListSelect = {
  id: true,
  userId: true,
  organizationId: true,
  fullName: true,
  email: true,
  designation: true,
  role: true,
  invitedAt: true,
  managerId: true,
  departmentId: true,
  joiningDate: true,
  leavingDate: true,
  createdAt: true,
  updatedAt: true,
  ...employeeIncludes,
} as const;

// ADMIN was previously excluded here (reserved for company registration) back
// when HR/MANAGER existed as lesser elevated roles. With those gone, ADMIN is
// the only way to grant management permissions in-app, so it's creatable here.
const creatableRoleSchema = z.enum(["ADMIN", "EMPLOYEE"]);
const emailSchema = z.email().trim().toLowerCase();

const createEmployeeSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  email: emailSchema,
  role: creatableRoleSchema,
  designation: z.string().trim().min(1).max(200).optional(),
  managerId: z.string().min(1).optional(),
  departmentId: z.string().min(1).optional(),
  joiningDate: z.coerce.date().optional(),
  leavingDate: z.coerce.date().optional(),
  employeeCode: z.string().trim().min(1).max(50).optional(),
  phone: z.string().trim().min(1).max(20).optional(),
  dateOfBirth: z.coerce.date().optional(),
  gender: z.string().trim().min(1).max(30).optional(),
  address: z.string().trim().min(1).max(500).optional(),
  emergencyContactName: z.string().trim().min(1).max(200).optional(),
  emergencyContactPhone: z.string().trim().min(1).max(20).optional(),
});

const updateEmployeeSchema = z.object({
  fullName: z.string().trim().min(1).max(200).optional(),
  email: emailSchema.optional(),
  role: creatableRoleSchema.optional(),
  designation: z.string().trim().min(1).max(200).nullable().optional(),
  managerId: z.string().min(1).nullable().optional(),
  departmentId: z.string().min(1).nullable().optional(),
  joiningDate: z.coerce.date().nullable().optional(),
  leavingDate: z.coerce.date().nullable().optional(),
  employeeCode: z.string().trim().min(1).max(50).nullable().optional(),
  phone: z.string().trim().min(1).max(20).nullable().optional(),
  dateOfBirth: z.coerce.date().nullable().optional(),
  gender: z.string().trim().min(1).max(30).nullable().optional(),
  address: z.string().trim().min(1).max(500).nullable().optional(),
  emergencyContactName: z.string().trim().min(1).max(200).nullable().optional(),
  emergencyContactPhone: z.string().trim().min(1).max(20).nullable().optional(),
});

const idParamSchema = z.object({ id: z.string().min(1) });

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

// managerId must reference an existing Employee in the same org — not
// something a DB constraint can enforce (the FK is to Employee.id globally),
// so it stays a manual check. Throws AppError on failure.
const validateManagerId = async (managerId: string, organizationId: string, selfId?: string): Promise<void> => {
  if (managerId === selfId) {
    throw new AppError(400, "VALIDATION", "An employee cannot be their own manager");
  }
  const manager = await prisma.employee.findFirst({ where: { id: managerId, organizationId } });
  if (!manager) {
    throw new AppError(400, "VALIDATION", "managerId must reference an employee in your organization");
  }
};

// Same shape of check as validateManagerId — departmentId isn't a real FK
// constraint we can lean on for the "same org" half of the rule.
const validateDepartmentId = async (departmentId: string, organizationId: string): Promise<void> => {
  const department = await prisma.department.findFirst({ where: { id: departmentId, organizationId } });
  if (!department) {
    throw new AppError(400, "VALIDATION", "departmentId must reference a department in your organization");
  }
};

export const employeeRoutes = async (app: FastifyInstance) => {
  app.post("/api/employees", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const { managerId, departmentId, ...body } = createEmployeeSchema.parse(request.body);
    const { organizationId } = request.auth;

    if (managerId) {
      await validateManagerId(managerId, organizationId);
    }
    if (departmentId) {
      await validateDepartmentId(departmentId, organizationId);
    }

    // Duplicate email (or employeeCode) in-org is caught by the respective
    // unique constraint and mapped to 409 CONFLICT centrally — no pre-check needed.
    const employee = await prisma.employee.create({
      data: { organizationId, managerId, departmentId, ...body },
      include: employeeIncludes,
    });

    reply.status(201);
    return ok({ employee });
  });

  app.patch("/api/employees/:id", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { id } = idParamSchema.parse(request.params);
    const body = updateEmployeeSchema.parse(request.body);
    const { managerId, departmentId } = body;

    const existing = await prisma.employee.findFirst({ where: { id, organizationId } });
    if (!existing) {
      throw new AppError(404, "NOT_FOUND", "Employee not found");
    }

    if (managerId) {
      await validateManagerId(managerId, organizationId, id);
    }
    if (departmentId) {
      await validateDepartmentId(departmentId, organizationId);
    }

    const employee = await prisma.employee.update({
      where: { id },
      data: body,
      include: employeeIncludes,
    });

    return ok({ employee });
  });

  app.get("/api/employees", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { page, pageSize } = listQuerySchema.parse(request.query);

    const [employees, total] = await Promise.all([
      prisma.employee.findMany({
        where: { organizationId },
        select: employeeListSelect,
        orderBy: { fullName: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.employee.count({ where: { organizationId } }),
    ]);

    return ok({ employees, page, pageSize, total });
  });

  app.get("/api/employees/:id", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { id } = idParamSchema.parse(request.params);

    const employee = await prisma.employee.findFirst({
      where: { id, organizationId },
      include: employeeIncludes,
    });
    if (!employee) {
      throw new AppError(404, "NOT_FOUND", "Employee not found");
    }

    return ok({ employee });
  });

  // Any authenticated org member can view the chart — it's read-only and
  // carries no sensitive fields (no email), unlike the ADMIN-gated CRUD above.
  app.get("/api/employees/org-chart", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId } = request.auth;

    // Single query for the whole org; the tree is assembled in memory by
    // buildOrgChartTree (src/modules/employees/orgChart.ts) — no per-node recursion into
    // the DB.
    const employees = await prisma.employee.findMany({
      where: { organizationId },
      select: { ...lightweightEmployeeSelect, managerId: true },
    });

    const tree = buildOrgChartTree(employees, (message) => request.log.warn(message));
    return ok({ tree });
  });

  app.get("/api/employees/:id/reports", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId } = request.auth;
    const { id } = idParamSchema.parse(request.params);

    const manager = await prisma.employee.findFirst({ where: { id, organizationId }, select: { id: true } });
    if (!manager) {
      throw new AppError(404, "NOT_FOUND", "Employee not found");
    }

    const reports = await prisma.employee.findMany({
      where: { organizationId, managerId: id },
      select: lightweightEmployeeSelect,
      orderBy: { fullName: "asc" },
    });

    return ok({
      reports: reports.map(({ userId, ...employee }) => ({ ...employee, hasPortalAccess: userId !== null })),
    });
  });
};
