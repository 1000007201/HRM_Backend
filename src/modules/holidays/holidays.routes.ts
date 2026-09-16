import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../core/prisma.js";
import { EmployeeRole } from "../../generated/prisma/client.js";
import { AppError } from "../../core/errors.js";
import { ok } from "../../core/response.js";
import { toHolidayYear } from "./holidays.js";

const ADMIN_ROLES = [EmployeeRole.ADMIN];
const HOLIDAY_SELECT = { id: true, date: true, name: true, year: true, isOptional: true } as const;

const idParamSchema = z.object({ id: z.string().min(1) });

// z.coerce.date() on a "YYYY-MM-DD" string parses as UTC midnight, which is
// exactly what the @db.Date column stores — see the UTC note in
// src/shared/workingDays.ts.
//
// `isOptional` defaults to false so the bulk paste/CSV format (just date +
// name) keeps working unchanged — an optional holiday is opt-in, set
// explicitly via POST /holidays. See the Holiday comment in schema.prisma for
// what the flag means.
const holidaySchema = z.object({
  date: z.coerce.date(),
  name: z.string().trim().min(1).max(200),
  isOptional: z.boolean().default(false),
});

const bulkHolidaysSchema = z.object({
  // A month's list or a full year's is the same shape, just longer — 366 is
  // the ceiling for one year, and the endpoint is per-org so this is a sane
  // upper bound rather than a real constraint.
  holidays: z.array(holidaySchema).min(1).max(366),
});

const listQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export const holidayRoutes = async (app: FastifyInstance) => {
  // Readable by any org member — everyone needs to see the company calendar.
  app.get("/holidays", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId } = request.auth;
    const { year = new Date().getUTCFullYear() } = listQuerySchema.parse(request.query);

    const holidays = await prisma.holiday.findMany({
      where: { organizationId, year },
      select: HOLIDAY_SELECT,
      orderBy: { date: "asc" },
    });

    return ok({ year, holidays });
  });

  // Readable by any org member — the Apply Leave form needs these to build
  // its floater-holiday date picker.
  app.get("/holidays/optional", { preHandler: app.requireAuth }, async (request) => {
    const { organizationId } = request.auth;
    const { year = new Date().getUTCFullYear() } = listQuerySchema.parse(request.query);

    const holidays = await prisma.holiday.findMany({
      where: { organizationId, year, isOptional: true },
      select: HOLIDAY_SELECT,
      orderBy: { date: "asc" },
    });

    return ok({ year, holidays });
  });

  app.post("/holidays", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request, reply) => {
    const { organizationId } = request.auth;
    const { date, name, isOptional } = holidaySchema.parse(request.body);

    // A duplicate date hits the organizationId_date unique constraint and is
    // mapped to 409 CONFLICT centrally — no pre-check needed. Use
    // POST /holidays/bulk to upsert instead of erroring on duplicates.
    const holiday = await prisma.holiday.create({
      data: { organizationId, date, name, isOptional, year: toHolidayYear(date) },
      select: HOLIDAY_SELECT,
    });

    reply.status(201);
    return ok({ holiday });
  });

  // One endpoint covers "upload a month" and "upload a year" — it's just a
  // longer or shorter list. Upserts rather than erroring on duplicates, so
  // re-uploading the same list is idempotent (a corrected name on an
  // existing date counts as `updated`, an identical entry as `unchanged`).
  app.post("/holidays/bulk", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { holidays } = bulkHolidaysSchema.parse(request.body);

    // Last entry wins on a duplicated date within one payload — upserting the
    // same date twice in a single transaction would otherwise be a
    // write-conflict on the unique constraint.
    const holidaysByDateKey = new Map(holidays.map((holiday) => [holiday.date.toISOString(), holiday]));
    const deduplicated = [...holidaysByDateKey.values()];

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.holiday.findMany({
        where: { organizationId, date: { in: deduplicated.map((holiday) => holiday.date) } },
        select: { date: true, name: true, isOptional: true },
      });
      const existingByDateKey = new Map(existing.map((holiday) => [holiday.date.toISOString(), holiday]));

      let added = 0;
      let updated = 0;
      let unchanged = 0;

      for (const holiday of deduplicated) {
        const existingHoliday = existingByDateKey.get(holiday.date.toISOString());
        if (existingHoliday === undefined) {
          added += 1;
        } else if (existingHoliday.name === holiday.name && existingHoliday.isOptional === holiday.isOptional) {
          unchanged += 1;
        } else {
          updated += 1;
        }

        await tx.holiday.upsert({
          where: { organizationId_date: { organizationId, date: holiday.date } },
          create: {
            organizationId,
            date: holiday.date,
            name: holiday.name,
            isOptional: holiday.isOptional,
            year: toHolidayYear(holiday.date),
          },
          update: { name: holiday.name, isOptional: holiday.isOptional },
        });
      }

      return { added, updated, unchanged };
    });

    return ok({
      ...result,
      duplicatesInPayload: holidays.length - deduplicated.length,
      received: holidays.length,
    });
  });

  app.delete("/holidays/:id", { preHandler: app.requireRole(ADMIN_ROLES) }, async (request) => {
    const { organizationId } = request.auth;
    const { id } = idParamSchema.parse(request.params);

    // deleteMany (not delete) so the org scope is part of the WHERE — a
    // holiday in another org matches nothing and 404s rather than being
    // deleted across the tenant boundary.
    const { count } = await prisma.holiday.deleteMany({ where: { id, organizationId } });
    if (count === 0) {
      throw new AppError(404, "NOT_FOUND", "Holiday not found");
    }

    return ok({ id });
  });
};
