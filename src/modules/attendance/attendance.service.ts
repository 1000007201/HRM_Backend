import { AttendanceStatus, Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../core/errors.js";
import { utcMidnight } from "../../shared/workingDays.js";
import { deriveDailyStatus, loadAttendanceContext, statusFromWorkedMinutes, toWorkedMinutes } from "./derivation.js";
import { getAttendanceSettings, weekOffSet } from "./attendanceSettings.service.js";

export const checkIn = async (prisma: PrismaClient, params: { organizationId: string; employeeId: string; now?: Date }) => {
  const { organizationId, employeeId } = params;
  const now = params.now ?? new Date();
  const today = utcMidnight(now);

  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.attendanceRecord.findUnique({
        where: { employeeId_date: { employeeId, date: today } },
      });
      if (existing?.checkInAt) {
        throw new AppError(409, "CONFLICT", "You have already checked in today");
      }

      const [context, settings] = await Promise.all([
        loadAttendanceContext(tx, organizationId, [employeeId], today, today),
        getAttendanceSettings(tx, organizationId),
      ]);
      const derived = deriveDailyStatus({
        date: today,
        today,
        holidayDateKeys: context.holidayDateKeys,
        approvedLeaveDateKeys: context.approvedLeaveDateKeysByEmployeeId.get(employeeId) ?? new Set(),
        record: null,
        fullDayMinutes: settings.fullDayMinutes,
        weekOffDays: weekOffSet(settings.weekOffDays),
      });
      if (derived === AttendanceStatus.WEEK_OFF) {
        throw new AppError(409, "CONFLICT", "Today is a week off — no check-in needed");
      }
      if (derived === AttendanceStatus.HOLIDAY) {
        throw new AppError(409, "CONFLICT", "Today is a company holiday — no check-in needed");
      }
      if (derived === AttendanceStatus.ON_LEAVE) {
        throw new AppError(409, "CONFLICT", "You are on approved leave today — no check-in needed");
      }

      return tx.attendanceRecord.upsert({
        where: { employeeId_date: { employeeId, date: today } },
        create: {
          organizationId,
          employeeId,
          date: today,
          checkInAt: now,
          status: AttendanceStatus.PRESENT,
          source: "SELF",
        },
        update: { checkInAt: now, status: AttendanceStatus.PRESENT, source: "SELF" },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
};

export const checkOut = async (
  prisma: PrismaClient,
  params: { organizationId: string; employeeId: string; now?: Date },
) => {
  const { organizationId, employeeId } = params;
  const now = params.now ?? new Date();
  const today = utcMidnight(now);

  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.attendanceRecord.findUnique({
        where: { employeeId_date: { employeeId, date: today } },
      });
      if (!existing?.checkInAt) {
        throw new AppError(409, "CONFLICT", "You have not checked in today");
      }
      if (existing.checkOutAt) {
        throw new AppError(409, "CONFLICT", "You have already checked out today");
      }

      const settings = await getAttendanceSettings(tx, organizationId);
      const workedMinutes = toWorkedMinutes(existing.checkInAt, now);
      return tx.attendanceRecord.update({
        where: { id: existing.id },
        data: {
          checkOutAt: now,
          workedMinutes,
          status: statusFromWorkedMinutes(workedMinutes, settings.fullDayMinutes),
        },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
};

export interface MarkAttendanceParams {
  organizationId: string;
  employeeId: string;
  date: Date;
  status?: AttendanceStatus;
  checkInAt?: Date;
  checkOutAt?: Date;
  note?: string;
}

// The direct HR override. The employee-initiated equivalent (request +
// approval, with an audit trail) lives in regularizations.service.ts.
export const markAttendance = async (prisma: PrismaClient, params: MarkAttendanceParams) => {
  const { organizationId, employeeId, status, checkInAt, checkOutAt, note } = params;
  const day = utcMidnight(params.date);

  const employee = await prisma.employee.findFirst({ where: { id: employeeId, organizationId }, select: { id: true } });
  if (!employee) {
    throw new AppError(404, "NOT_FOUND", "Employee not found");
  }

  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.attendanceRecord.findUnique({
        where: { employeeId_date: { employeeId, date: day } },
      });

      const mergedCheckInAt = checkInAt ?? existing?.checkInAt ?? null;
      const mergedCheckOutAt = checkOutAt ?? existing?.checkOutAt ?? null;
      if (mergedCheckInAt && mergedCheckOutAt && mergedCheckOutAt <= mergedCheckInAt) {
        throw new AppError(400, "VALIDATION", "checkOutAt must be after checkInAt");
      }
      const workedMinutes =
        mergedCheckInAt && mergedCheckOutAt ? toWorkedMinutes(mergedCheckInAt, mergedCheckOutAt) : null;

      const settings = await getAttendanceSettings(tx, organizationId);
      const data = {
        checkInAt: mergedCheckInAt,
        checkOutAt: mergedCheckOutAt,
        workedMinutes,
        status: status ?? statusFromWorkedMinutes(workedMinutes, settings.fullDayMinutes),
        source: "HR_MARKED",
        note: note ?? existing?.note ?? null,
      } as const;

      return tx.attendanceRecord.upsert({
        where: { employeeId_date: { employeeId, date: day } },
        create: { organizationId, employeeId, date: day, ...data },
        update: data,
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
};
