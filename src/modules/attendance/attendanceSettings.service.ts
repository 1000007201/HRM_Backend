import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../core/errors.js";

type Db = PrismaClient | Prisma.TransactionClient;

export const getAttendanceSettings = async (db: Db, organizationId: string) =>
  db.attendanceSettings.upsert({
    where: { organizationId },
    create: { organizationId },
    update: {},
  });

export const weekOffSet = (weekOffDays: number[]): ReadonlySet<number> => new Set(weekOffDays);

export interface UpdateAttendanceSettingsParams {
  fullDayMinutes?: number;
  halfDayMinutes?: number;
  weekOffDays?: number[];
  allowRegularization?: boolean;
  maxRegularizationsPerMonth?: number | null;
  regularizationWindowDays?: number | null;
}

export const updateAttendanceSettings = async (
  prisma: PrismaClient,
  organizationId: string,
  params: UpdateAttendanceSettingsParams,
) => {
  const existing = await getAttendanceSettings(prisma, organizationId);

  const fullDayMinutes = params.fullDayMinutes ?? existing.fullDayMinutes;
  const halfDayMinutes = params.halfDayMinutes ?? existing.halfDayMinutes;

  if (halfDayMinutes >= fullDayMinutes) {
    throw new AppError(400, "VALIDATION", "halfDayMinutes must be less than fullDayMinutes");
  }

  return prisma.attendanceSettings.update({
    where: { organizationId },
    data: params,
  });
};
