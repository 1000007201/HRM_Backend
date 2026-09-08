import type { FastifyInstance } from "fastify";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "../../core/prisma.js";
import { EmployeeDocumentType, EmployeeRole } from "../../generated/prisma/client.js";
import { AppError } from "../../core/errors.js";
import { ok } from "../../core/response.js";

const ADMIN_ROLES: EmployeeRole[] = [EmployeeRole.ADMIN];

export const DOCUMENT_UPLOAD_DIR = path.join(process.cwd(), "uploads", "employee-documents");
export const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024;
const ALLOWED_DOCUMENT_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

const idParamSchema = z.object({ id: z.string().min(1) });
const documentParamSchema = z.object({ id: z.string().min(1), documentId: z.string().min(1) });
const documentTypeSchema = z.enum(EmployeeDocumentType);

// requireRole already checked HR/ADMIN for upload/delete; this is the
// weaker check for read routes — the document owner or HR/ADMIN.
const assertCanViewDocuments = (employeeId: string, auth: { employeeId: string; role: EmployeeRole }): void => {
  if (employeeId !== auth.employeeId && !ADMIN_ROLES.includes(auth.role)) {
    throw new AppError(403, "FORBIDDEN", "Forbidden");
  }
};

export const employeeDocumentRoutes = async (app: FastifyInstance) => {
  app.post("/api/employees/:id/documents", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId, employeeId: uploadedById } = request.auth;
    const { id: employeeId } = idParamSchema.parse(request.params);

    const employee = await prisma.employee.findFirst({ where: { id: employeeId, organizationId } });
    if (!employee) {
      throw new AppError(404, "NOT_FOUND", "Employee not found");
    }

    const file = await request.file();
    if (!file) {
      throw new AppError(400, "VALIDATION", "No file uploaded");
    }
    const type = documentTypeSchema.parse((file.fields.type as { value?: unknown } | undefined)?.value);

    if (!ALLOWED_DOCUMENT_MIME_TYPES.has(file.mimetype)) {
      throw new AppError(400, "VALIDATION", "Unsupported file type — only PDF, JPEG or PNG allowed");
    }

    await fs.mkdir(DOCUMENT_UPLOAD_DIR, { recursive: true });
    const storagePath = `${randomUUID()}${path.extname(file.filename)}`;
    await pipeline(file.file, createWriteStream(path.join(DOCUMENT_UPLOAD_DIR, storagePath)));

    if (file.file.truncated) {
      await fs.unlink(path.join(DOCUMENT_UPLOAD_DIR, storagePath)).catch(() => {});
      throw new AppError(400, "VALIDATION", "File exceeds the 10MB size limit");
    }

    const { size: fileSize } = await fs.stat(path.join(DOCUMENT_UPLOAD_DIR, storagePath));

    const document = await prisma.employeeDocument.create({
      data: {
        organizationId,
        employeeId,
        uploadedById,
        type,
        fileName: file.filename,
        storagePath,
        mimeType: file.mimetype,
        fileSize,
      },
    });

    return ok({ document });
  });

  app.get("/api/employees/:id/documents", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId } = request.auth;
    const { id: employeeId } = idParamSchema.parse(request.params);
    assertCanViewDocuments(employeeId, request.auth);

    const documents = await prisma.employeeDocument.findMany({
      where: { employeeId, organizationId },
      orderBy: { createdAt: "desc" },
    });

    return ok({ documents });
  });

  app.get(
    "/api/employees/:id/documents/:documentId/download",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { organizationId } = request.auth;
      const { id: employeeId, documentId } = documentParamSchema.parse(request.params);
      assertCanViewDocuments(employeeId, request.auth);

      const document = await prisma.employeeDocument.findFirst({
        where: { id: documentId, employeeId, organizationId },
      });
      if (!document) {
        throw new AppError(404, "NOT_FOUND", "Document not found");
      }

      const fileBuffer = await fs.readFile(path.join(DOCUMENT_UPLOAD_DIR, document.storagePath));
      reply.header("Content-Type", document.mimeType);
      reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(document.fileName)}"`);
      return reply.send(fileBuffer);
    },
  );

  app.delete(
    "/api/employees/:id/documents/:documentId",
    { preHandler: app.requireRole(ADMIN_ROLES) },
    async (request) => {
      const { organizationId } = request.auth;
      const { id: employeeId, documentId } = documentParamSchema.parse(request.params);

      const document = await prisma.employeeDocument.findFirst({
        where: { id: documentId, employeeId, organizationId },
      });
      if (!document) {
        throw new AppError(404, "NOT_FOUND", "Document not found");
      }

      await prisma.employeeDocument.delete({ where: { id: document.id } });
      await fs.unlink(path.join(DOCUMENT_UPLOAD_DIR, document.storagePath)).catch(() => {});

      return ok({ deleted: true });
    },
  );
};
