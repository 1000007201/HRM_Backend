import { type LopBasis, type Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { buildMonthlyAttendance, monthBounds } from "../attendance/derivation.js";
import { getHolidayDateKeys } from "../holidays/holidays.js";
import { countWorkingDays, eachUtcDateInRange } from "../../shared/workingDays.js";
import { env } from "../../env.js";

type Db = PrismaClient | Prisma.TransactionClient;

const HALF_DAY_THRESHOLD_MINUTES = env.ATTENDANCE_HALF_DAY_THRESHOLD_MINUTES;

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

  const days = await buildMonthlyAttendance(db, {
    organizationId,
    employeeId,
    year,
    month,
    today: new Date(),
    halfDayThresholdMinutes: HALF_DAY_THRESHOLD_MINUTES,
  });
  const absentDays = days.filter((day) => day.status === "ABSENT").length;
  const workingDaysInMonth = days.filter((day) => day.status !== "WEEK_OFF" && day.status !== "HOLIDAY").length;
  const calendarDaysInMonth = eachUtcDateInRange(startDate, endDate).length;

  const holidayDateKeys = await getHolidayDateKeys(db, organizationId, startDate, endDate);
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
    return sum + countWorkingDays(overlapStart, overlapEnd, leave.isHalfDay, holidayDateKeys);
  }, 0);

  const daysInMonth = lopBasis === "WORKING_DAYS" ? workingDaysInMonth : calendarDaysInMonth;
  const lopDays = Math.min(Math.round(absentDays + unpaidLeaveDays), daysInMonth);

  return { daysInMonth, lopDays, paidDays: daysInMonth - lopDays };
};
