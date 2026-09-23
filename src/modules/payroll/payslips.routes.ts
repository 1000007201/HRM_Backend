import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
// archiver 8's API is class-based (ZipArchive), not the classic
// archiver('zip', options) factory the Stage 6 spec assumed.
import { ZipArchive } from "archiver";
import { z } from "zod";
import { prisma } from "../../core/prisma.js";
import { EmployeeRole } from "../../generated/prisma/client.js";
import { ok } from "../../core/response.js";
import { AppError } from "../../core/errors.js";
import { getQueueInstance, PAYSLIP_BATCH_TRIGGER_QUEUE, PAYSLIP_GENERATE_AND_EMAIL_QUEUE } from "../../lib/queue.js";
import { getPayrollRun } from "./payrollRuns.service.js";
import {
  getEmployeePayslipPdfPath,
  getPayslip,
  getPayslipPdfPathsForRun,
  listEmployeePayslips,
  listPayslipsForRun,
} from "./payslips.service.js";

const ADMIN_ROLES = [EmployeeRole.ADMIN];

const runIdParamSchema = z.object({ runId: z.string().min(1) });
const payslipParamSchema = z.object({ runId: z.string().min(1), id: z.string().min(1) });
const employeeIdParamSchema = z.object({ employeeId: z.string().min(1) });
const employeePayslipPdfParamSchema = z.object({ employeeId: z.string().min(1), payslipId: z.string().min(1) });

export const payslipRoutes = async (app: FastifyInstance) => {
  app.get("/api/payroll-runs/:runId/payslips", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { runId } = runIdParamSchema.parse(request.params);

    const payslips = await listPayslipsForRun(prisma, { organizationId, runId });
    return ok({ payslips });
  });

  // Not admin-only: an employee needs this for their own payslip's full
  // component breakdown (listEmployeePayslips only returns summary rows) —
  // getPayslip enforces self-or-admin, plus APPROVED/PAID-only for a
  // non-admin caller.
  app.get("/api/payroll-runs/:runId/payslips/:id", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId, employeeId: requestingEmployeeId, role } = request.auth;
    const { runId, id } = payslipParamSchema.parse(request.params);

    const payslip = await getPayslip(prisma, { organizationId, runId, payslipId: id, requestingEmployeeId, requestingRole: role });
    return ok({ payslip });
  });

  app.get("/api/employees/:employeeId/payslips", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId, employeeId: requestingEmployeeId, role } = request.auth;
    const { employeeId } = employeeIdParamSchema.parse(request.params);

    const payslips = await listEmployeePayslips(prisma, { organizationId, employeeId, requestingEmployeeId, requestingRole: role });
    return ok({ payslips });
  });

  // Self-or-admin (enforced in getEmployeePayslipPdfPath). Generates the PDF
  // on the fly if the queue job hasn't run yet or failed — every code path
  // that serves a PDF has to be able to produce one, not just read one.
  app.get("/api/employees/:employeeId/payslips/:payslipId/pdf", { preHandler: app.requireAuth }, async (request, reply) => {
    const { organizationId, employeeId: requestingEmployeeId, role } = request.auth;
    const { employeeId, payslipId } = employeePayslipPdfParamSchema.parse(request.params);

    const { absolutePath, fileName } = await getEmployeePayslipPdfPath(prisma, {
      organizationId,
      employeeId,
      payslipId,
      requestingEmployeeId,
      requestingRole: role,
    });

    const pdfBuffer = await fs.readFile(absolutePath);
    reply.header("Content-Type", "application/pdf");
    reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`);
    return reply.send(pdfBuffer);
  });

  // Admin bulk download — every payslip in the run, zipped. Streamed
  // directly to the response (archiver pipes into it) rather than buffered,
  // since a run can hold hundreds of PDFs.
  app.get("/api/payroll-runs/:runId/payslips/download-all", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const { organizationId } = request.auth;
    const { runId } = runIdParamSchema.parse(request.params);

    const { month, year, files } = await getPayslipPdfPathsForRun(prisma, { organizationId, runId });

    const archive = new ZipArchive({ zlib: { level: 5 } });
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", `attachment; filename="payslips-${String(month).padStart(2, "0")}-${year}.zip"`);
    reply.send(archive);

    for (const file of files) {
      archive.file(file.absolutePath, { name: file.fileName });
    }
    await archive.finalize();
  });

  // Re-queues generation for every payslip in the run without emailing
  // anyone — useful after a template change, to refresh PDFs for a past run.
  // Only validates (via getPayrollRun) — deliberately does NOT call
  // getPayslipPdfPathsForRun, which would synchronously generate every
  // missing PDF inline right here instead of leaving that to the queue.
  app.post("/api/payroll-runs/:runId/payslips/regenerate-pdfs", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { runId } = runIdParamSchema.parse(request.params);

    const run = await getPayrollRun(prisma, { organizationId, runId });
    if (run.status !== "APPROVED" && run.status !== "PAID") {
      throw new AppError(409, "CONFLICT", "Payslip PDFs are only available for an APPROVED or PAID run");
    }

    const boss = await getQueueInstance();
    await boss.send(PAYSLIP_BATCH_TRIGGER_QUEUE, { payrollRunId: runId, organizationId, sendEmail: false });

    return ok({ queued: true });
  });

  app.get("/api/admin/queue-stats", { preHandler: app.requireRole(ADMIN_ROLES) }, async () => {
    const boss = await getQueueInstance();
    const [stats] = await boss.getQueueStats(PAYSLIP_GENERATE_AND_EMAIL_QUEUE);

    return ok({
      pending: stats?.readyCount ?? 0,
      active: stats?.activeCount ?? 0,
      failed: stats?.failedCount ?? 0,
      total: stats?.totalCount ?? 0,
    });
  });
};
