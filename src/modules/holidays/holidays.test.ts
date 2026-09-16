import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../core/prisma.js";
import { getHolidayDateKeys, toHolidayYear } from "./holidays.js";
import { countWorkingDays } from "../../shared/workingDays.js";

const utcDate = (isoDate: string): Date => new Date(`${isoDate}T00:00:00.000Z`);

// Round-trips real rows through Postgres `@db.Date`: the keys coming back
// have to match what countWorkingDays looks up, or holidays silently stop
// being excluded. Disposable org, cleaned up via cascade delete.
test("holidays stored in the DB round-trip into keys countWorkingDays actually excludes", async () => {
  const organization = await prisma.organization.create({
    data: { id: randomUUID(), name: "Holiday Test Co", slug: `holiday-test-${randomUUID()}`, createdAt: new Date() },
  });

  try {
    const holiday = utcDate("2026-03-04"); // a Wednesday
    await prisma.holiday.create({
      data: { organizationId: organization.id, date: holiday, name: "Test Holiday", year: toHolidayYear(holiday) },
    });

    const weekStart = utcDate("2026-03-02");
    const weekEnd = utcDate("2026-03-06");
    const holidayKeys = await getHolidayDateKeys(prisma, organization.id, weekStart, weekEnd);

    assert.deepEqual([...holidayKeys], ["2026-03-04"], "DB date must key to its own UTC calendar day");
    assert.equal(countWorkingDays(weekStart, weekEnd, false, holidayKeys), 4, "Mon-Fri minus one holiday");

    // Tenant scoping: another org's range query must not see this holiday.
    const otherOrgKeys = await getHolidayDateKeys(prisma, randomUUID(), weekStart, weekEnd);
    assert.equal(otherOrgKeys.size, 0);

    // Range scoping: a window that excludes the holiday returns nothing.
    const laterKeys = await getHolidayDateKeys(prisma, organization.id, utcDate("2026-03-05"), weekEnd);
    assert.equal(laterKeys.size, 0);
  } finally {
    await prisma.organization.delete({ where: { id: organization.id } });
  }
});

// The property that makes an optional holiday "optional": someone who
// doesn't take it still has it count as a normal working day, unlike a
// non-optional holiday which reduces everyone's leave cost.
test("an optional holiday is not excluded from countWorkingDays, unlike a non-optional one", async () => {
  const organization = await prisma.organization.create({
    data: { id: randomUUID(), name: "Floater Test Co", slug: `floater-test-${randomUUID()}`, createdAt: new Date() },
  });

  try {
    const closure = utcDate("2026-03-04"); // Wednesday
    const optional = utcDate("2026-03-05"); // Thursday
    await prisma.holiday.createMany({
      data: [
        { organizationId: organization.id, date: closure, name: "Company Closure", year: toHolidayYear(closure), isOptional: false },
        { organizationId: organization.id, date: optional, name: "Optional Holiday", year: toHolidayYear(optional), isOptional: true },
      ],
    });

    const weekStart = utcDate("2026-03-02");
    const weekEnd = utcDate("2026-03-06");
    const holidayKeys = await getHolidayDateKeys(prisma, organization.id, weekStart, weekEnd);

    assert.deepEqual([...holidayKeys], ["2026-03-04"], "only the non-optional date is excluded");
    assert.equal(countWorkingDays(weekStart, weekEnd, false, holidayKeys), 4, "Mon-Fri minus the non-optional holiday only");

    const optionalHolidayKeys = await getHolidayDateKeys(prisma, organization.id, weekStart, weekEnd, true);
    assert.deepEqual([...optionalHolidayKeys], ["2026-03-05"], "isOptional=true fetches the other set");
  } finally {
    await prisma.organization.delete({ where: { id: organization.id } });
  }
});

test("re-upserting the same holiday date does not create a duplicate", async () => {
  const organization = await prisma.organization.create({
    data: { id: randomUUID(), name: "Holiday Upsert Co", slug: `holiday-upsert-${randomUUID()}`, createdAt: new Date() },
  });

  try {
    const date = utcDate("2026-01-26");
    const upsert = (name: string) =>
      prisma.holiday.upsert({
        where: { organizationId_date: { organizationId: organization.id, date } },
        create: { organizationId: organization.id, date, name, year: toHolidayYear(date) },
        update: { name },
      });

    await upsert("Republic Day");
    await upsert("Republic Day");
    await upsert("Republic Day (observed)");

    const holidays = await prisma.holiday.findMany({ where: { organizationId: organization.id } });
    assert.equal(holidays.length, 1, "same date upserts in place rather than duplicating");
    assert.equal(holidays[0]!.name, "Republic Day (observed)", "a changed name updates the existing row");
    assert.equal(holidays[0]!.year, 2026, "year is derived from the date");
  } finally {
    await prisma.organization.delete({ where: { id: organization.id } });
  }
});
