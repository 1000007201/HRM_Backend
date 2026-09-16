import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { toUtcDateKey } from "../../shared/workingDays.js";

type Db = PrismaClient | Prisma.TransactionClient;

// Builds the holiday-key set countWorkingDays expects, for one org over one
// date range. This is the only intended way to build that set — it pairs the
// tenant-scoped query with toUtcDateKey so the key format can't drift from
// what countWorkingDays looks up.
//
// Defaults to isOptional=false: an optional holiday is a candidate date, not
// a closure day — excluding it here would wrongly shrink the working-day
// cost of every OTHER employee's leave request that happens to span it. An
// employee who actually takes an optional date does so via an ordinary
// LeaveRequest against the org's isFloater LeaveType (see the Holiday
// comment in schema.prisma), which already reduces their own balance without
// touching this org-wide set. Pass isOptional=true to get the other set
// instead — submitLeaveRequest uses that to check a floater request's date
// is actually a listed optional holiday.
export const getHolidayDateKeys = async (
  db: Db,
  organizationId: string,
  startDate: Date,
  endDate: Date,
  isOptional = false,
): Promise<Set<string>> => {
  const holidays = await db.holiday.findMany({
    where: { organizationId, date: { gte: startDate, lte: endDate }, isOptional },
    select: { date: true },
  });

  return new Set(holidays.map((holiday) => toUtcDateKey(holiday.date)));
};

// A holiday's `year` column is derived from its date rather than accepted
// from the client — see the comment on Holiday.year in prisma/schema.prisma.
export const toHolidayYear = (date: Date): number => date.getUTCFullYear();
