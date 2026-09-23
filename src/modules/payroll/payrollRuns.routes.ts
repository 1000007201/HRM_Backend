import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../core/prisma.js";
import { EmployeeRole } from "../../generated/prisma/client.js";
import { ok } from "../../core/response.js";
import { getQueueInstance, PAYSLIP_BATCH_TRIGGER_QUEUE } from "../../lib/queue.js";
import {
  approvePayrollRun,
  cancelPayrollRun,
  createPayrollRun,
  getPayrollRun,
  listPayrollRuns,
  markPayrollRunPaid,
  processPayrollRun,
} from "./payrollRuns.service.js";

const ADMIN_ROLES = [EmployeeRole.ADMIN];

const runIdParamSchema = z.object({ id: z.string().min(1) });
const createRunSchema = z.object({ month: z.number().int().min(1).max(12), year: z.number().int().min(2000) });
const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

export const payrollRunRoutes = async (app: FastifyInstance) => {
  app.post("/api/payroll-runs", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const { organizationId } = request.auth;
    const body = createRunSchema.parse(request.body);

    const run = await createPayrollRun(prisma, { organizationId, ...body });
    reply.status(201);
    return ok({ run });
  });

  app.get("/api/payroll-runs", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { page, pageSize } = listQuerySchema.parse(request.query);

    return ok(await listPayrollRuns(prisma, { organizationId, page, pageSize }));
  });

  app.get("/api/payroll-runs/:id", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { id } = runIdParamSchema.parse(request.params);

    const run = await getPayrollRun(prisma, { organizationId, runId: id });
    return ok({ run });
  });

  app.post("/api/payroll-runs/:id/process", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { id } = runIdParamSchema.parse(request.params);

    const run = await processPayrollRun(prisma, { organizationId, runId: id });
    return ok({ run });
  });

  // Same guard/behavior as /process — reprocessing is just re-triggering the
  // computation from REVIEW instead of DRAFT. See processPayrollRun.
  app.post("/api/payroll-runs/:id/reprocess", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { id } = runIdParamSchema.parse(request.params);

    const run = await processPayrollRun(prisma, { organizationId, runId: id });
    return ok({ run });
  });

  app.post("/api/payroll-runs/:id/approve", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId, employeeId } = request.auth;
    const { id } = runIdParamSchema.parse(request.params);

    const run = await approvePayrollRun(prisma, { organizationId, runId: id, approvedByEmployeeId: employeeId });

    // Fire-and-forget: the API responds with the approved run immediately,
    // PDFs/emails generate in the background — see payslip-worker.ts.
    const boss = await getQueueInstance();
    await boss.send(PAYSLIP_BATCH_TRIGGER_QUEUE, { payrollRunId: run.id, organizationId, sendEmail: true });

    return ok({ run });
  });

  app.post("/api/payroll-runs/:id/pay", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { id } = runIdParamSchema.parse(request.params);

    const run = await markPayrollRunPaid(prisma, { organizationId, runId: id });
    return ok({ run });
  });

  app.post("/api/payroll-runs/:id/cancel", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { id } = runIdParamSchema.parse(request.params);

    const run = await cancelPayrollRun(prisma, { organizationId, runId: id });
    return ok({ run });
  });
};
