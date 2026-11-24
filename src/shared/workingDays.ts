// The ONE place weekend + holiday logic lives for the whole leave system.
// Every place that turns a date range into a day count (submission, balance
// checks) must call countWorkingDays, never re-derive it.
//
// Holidays are INJECTED, not queried here: countWorkingDays stays a pure,
// synchronous function so it's testable without a database and does no
// hidden I/O. Callers fetch the org's holiday keys first — see
// getHolidayDateKeys in src/modules/holidays/holidays.ts, which is the only intended way
// to build that set.
//
// Dates are read/compared in UTC throughout, matching how Prisma round-trips
// `@db.Date` columns (as UTC-midnight Date objects) — this keeps day-of-week
// stable regardless of the server's local timezone.

export const utcMidnight = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

// "YYYY-MM-DD" in UTC — the key format for holidayDateKeys. Exported so the
// set-building side (src/modules/holidays/holidays.ts) formats keys identically; a
// mismatch here would silently stop holidays from being excluded.
export const toUtcDateKey = (date: Date): string => date.toISOString().slice(0, 10);

const DEFAULT_WEEK_OFF_DAYS: ReadonlySet<number> = new Set([0, 6]);

export const isWeekOff = (date: Date, weekOffDays: ReadonlySet<number>): boolean =>
  weekOffDays.has(date.getUTCDay());

export const isWeekend = (date: Date): boolean => isWeekOff(date, DEFAULT_WEEK_OFF_DAYS);

export const countWorkingDays = (
  startDate: Date,
  endDate: Date,
  isHalfDay: boolean,
  holidayDateKeys: ReadonlySet<string> = new Set(),
  weekOffDays: ReadonlySet<number> = DEFAULT_WEEK_OFF_DAYS,
): number => {
  const isNonWorking = (date: Date): boolean => isWeekOff(date, weekOffDays) || holidayDateKeys.has(toUtcDateKey(date));

  if (isHalfDay) {
    return isNonWorking(startDate) ? 0 : 0.5;
  }

  let workingDays = 0;
  const cursor = utcMidnight(startDate);
  const end = utcMidnight(endDate);

  while (cursor <= end) {
    if (!isNonWorking(cursor)) {
      workingDays += 1;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return workingDays;
};

// Every UTC calendar day from start to end, inclusive. Shared by the day
// counter above and attendance's month builder so range-walking is written
// once.
export const eachUtcDateInRange = (startDate: Date, endDate: Date): Date[] => {
  const dates: Date[] = [];
  const cursor = utcMidnight(startDate);
  const end = utcMidnight(endDate);

  while (cursor <= end) {
    dates.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
};

export const isSameUtcCalendarDay = (a: Date, b: Date): boolean =>
  a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
