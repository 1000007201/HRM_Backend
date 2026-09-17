import type { FastifyInstance } from "fastify";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "../../core/prisma.js";
import { EmployeeRole, ExpenseStatus } from "../../generated/prisma/client.js";
import { AppError } from "../../core/errors.js";
import { ok } from "../../core/response.js";
import { ALLOWED_DOCUMENT_MIME_TYPES, MAX_DOCUMENT_SIZE_BYTES } from "../employees/employeeDocuments.routes.js";

export const EXPENSE_ATTACHMENT_UPLOAD_DIR = path.join(process.cwd(), "uploads", "expense-attachments");

// Bills (the "attachments") mirror EmployeeDocument's upload security: a
// generated UUID filename on disk (never the caller-supplied name, so a
// crafted fileName can't traverse or collide), same mime/size limits — reused
// from employeeDocuments.routes.ts rather than duplicated, since the
// multipart plugin's global size cap (see server.ts) is already fixed to
// MAX_DOCUMENT_SIZE_BYTES regardless of what a local constant here claimed.

// Looser than the delete gate below: a bill can be added any time before the
// request is finalized (rejected, cancelled, or already paid) — including
// after the manager has approved it, e.g. to add a bill the employee forgot.
const NOT_UPLOADABLE_STATUSES: ExpenseStatus[] = [
  ExpenseStatus.PAYMENT_INITIATED,
  ExpenseStatus.REJECTED,
  ExpenseStatus.CANCELLED,
];

const idParamSchema = z.object({ id: z.string().min(1) });
const attachmentParamSchema = z.object({ id: z.string().min(1), attId: z.string().min(1) });

export const expenseAttachmentRoutes = async (app: FastifyInstance) => {
  app.post("/expenses/:id/attachments", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId, employeeId } = request.auth;
    const { id: expenseRequestId } = idParamSchema.parse(request.params);

    const expenseRequest = await prisma.expenseRequest.findFirst({ where: { id: expenseRequestId, organizationId } });
    if (!expenseRequest) {
      throw new AppError(404, "NOT_FOUND", "Expense request not found");
    }
    if (expenseRequest.employeeId !== employeeId) {
      throw new AppError(403, "FORBIDDEN", "Only the raiser can attach bills to this request");
    }
    if (NOT_UPLOADABLE_STATUSES.includes(expenseRequest.status)) {
      throw new AppError(409, "CONFLICT", "This request is finalized — bills can no longer be attached");
    }

    const file = await request.file();
    if (!file) {
      throw new AppError(400, "VALIDATION", "No file uploaded");
    }
    if (!ALLOWED_DOCUMENT_MIME_TYPES.has(file.mimetype)) {
      throw new AppError(400, "VALIDATION", "Unsupported file type — only PDF, JPEG or PNG allowed");
    }

    await fs.mkdir(EXPENSE_ATTACHMENT_UPLOAD_DIR, { recursive: true });
    const storagePath = `${randomUUID()}${path.extname(file.filename)}`;
    await pipeline(file.file, createWriteStream(path.join(EXPENSE_ATTACHMENT_UPLOAD_DIR, storagePath)));

    if (file.file.truncated) {
      await fs.unlink(path.join(EXPENSE_ATTACHMENT_UPLOAD_DIR, storagePath)).catch(() => {});
      throw new AppError(400, "VALIDATION", `File exceeds the ${MAX_DOCUMENT_SIZE_BYTES / (1024 * 1024)}MB size limit`);
    }

    const { size: fileSize } = await fs.stat(path.join(EXPENSE_ATTACHMENT_UPLOAD_DIR, storagePath));

    const attachment = await prisma.expenseAttachment.create({
      data: {
        expenseRequestId,
        uploadedById: employeeId,
        fileName: file.filename,
        storagePath,
        mimeType: file.mimetype,
        fileSize,
      },
    });

    return ok({ attachment });
  });

  app.get("/expenses/:id/attachments/:attId/download", { preHandler: app.requireAuth }, async (request, reply) => {
    const { organizationId, employeeId, role } = request.auth;
    const { id: expenseRequestId, attId } = attachmentParamSchema.parse(request.params);

    const expenseRequest = await prisma.expenseRequest.findFirst({ where: { id: expenseRequestId, organizationId } });
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

    const attachment = await prisma.expenseAttachment.findFirst({ where: { id: attId, expenseRequestId } });
    if (!attachment) {
      throw new AppError(404, "NOT_FOUND", "Attachment not found");
    }

    const fileBuffer = await fs.readFile(path.join(EXPENSE_ATTACHMENT_UPLOAD_DIR, attachment.storagePath));
    reply.header("Content-Type", attachment.mimeType);
    reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(attachment.fileName)}"`);
    return reply.send(fileBuffer);
  });

  // Stricter than upload: only while PENDING_MANAGER, so a bill can't be
  // pulled out from under an approver once someone has started reviewing it.
  app.delete("/expenses/:id/attachments/:attId", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId, employeeId } = request.auth;
    const { id: expenseRequestId, attId } = attachmentParamSchema.parse(request.params);

    const expenseRequest = await prisma.expenseRequest.findFirst({ where: { id: expenseRequestId, organizationId } });
    if (!expenseRequest) {
      throw new AppError(404, "NOT_FOUND", "Expense request not found");
    }
    if (expenseRequest.employeeId !== employeeId) {
      throw new AppError(403, "FORBIDDEN", "Only the raiser can remove bills from this request");
    }
    if (expenseRequest.status !== ExpenseStatus.PENDING_MANAGER) {
      throw new AppError(409, "CONFLICT", "Bills can only be removed while the request is awaiting manager approval");
    }

    const attachment = await prisma.expenseAttachment.findFirst({ where: { id: attId, expenseRequestId } });
    if (!attachment) {
      throw new AppError(404, "NOT_FOUND", "Attachment not found");
    }

    await prisma.expenseAttachment.delete({ where: { id: attachment.id } });
    await fs.unlink(path.join(EXPENSE_ATTACHMENT_UPLOAD_DIR, attachment.storagePath)).catch(() => {});

    return ok({ deleted: true });
  });
};
