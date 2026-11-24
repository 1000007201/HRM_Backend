import { type LopBasis, type Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { buildMonthlyAttendance, monthBounds } from "../attendance/derivation.js";
import { getHolidayDateKeys } from "../holidays/holidays.js";
import { countWorkingDays, eachUtcDateInRange } from "../../shared/workingDays.js";
import { getAttendanceSettings, weekOffSet } from "../attendance/attendanceSettings.service.js";

type Db = PrismaClient | Prisma.TransactionClient;

export interface LopResult {
  daysInMonth: number;
  lopDays: number;
  paidDays: number;
}

// Reuses attendance's deriveDailyStatus (via buildMonthlyAttendance, see
// CLAUDE.md's "one place attendance/leave/holiday reconciliation lives") for
// ABSENT days. Attendance only marks a day ON_LEAVE though — it doesn't know
// whether the leave type was paid (LeaveType.isPaid) — so unpaid-leave days
// are counted here with a direct query, same pattern countWorkingDays uses
// for a LeaveRequest's own submission-time day count.
export const computeLopAndPaidDays = async (
  db: Db,
  params: { organizationId: string; employeeId: string; month: number; year: number; lopBasis: LopBasis },
): Promise<LopResult> => {
  const { organizationId, employeeId, month, year, lopBasis } = params;
  const { startDate, endDate } = monthBounds(year, month);

  const [days, settings, holidayDateKeys] = await Promise.all([
    buildMonthlyAttendance(db, { organizationId, employeeId, year, month, today: new Date() }),
    getAttendanceSettings(db, organizationId),
    getHolidayDateKeys(db, organizationId, startDate, endDate),
  ]);

  const absentDays = days.filter((day) => day.status === "ABSENT").length;
  const workingDaysInMonth = days.filter((day) => day.status !== "WEEK_OFF" && day.status !== "HOLIDAY").length;
  const calendarDaysInMonth = eachUtcDateInRange(startDate, endDate).length;

  const wod = weekOffSet(settings.weekOffDays);
  const unpaidLeaves = await db.leaveRequest.findMany({
    where: {
      organizationId,
      employeeId,
      status: "APPROVED",
      startDate: { lte: endDate },
      endDate: { gte: startDate },
      leaveType: { isPaid: false },
    },
    select: { startDate: true, endDate: true, isHalfDay: true },
  });
  const unpaidLeaveDays = unpaidLeaves.reduce((sum, leave) => {
    // Clip to this month — a leave request can span a month boundary, but
    // only the days inside this period count as LOP for this payslip.
    const overlapStart = leave.startDate < startDate ? startDate : leave.startDate;
    const overlapEnd = leave.endDate > endDate ? endDate : leave.endDate;
    return sum + countWorkingDays(overlapStart, overlapEnd, leave.isHalfDay, holidayDateKeys, wod);
  }, 0);

  const daysInMonth = lopBasis === "WORKING_DAYS" ? workingDaysInMonth : calendarDaysInMonth;
  const lopDays = Math.min(Math.round(absentDays + unpaidLeaveDays), daysInMonth);

  return { daysInMonth, lopDays, paidDays: daysInMonth - lopDays };
};
