import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../core/prisma.js";
import { AppError } from "../../core/errors.js";
import { approveLeaveRequest, rejectLeaveRequest, submitLeaveRequest } from "./leaveRequests.service.js";

// The money path: submit reserves, approve deducts. Previously reachable only
// over HTTP; extracting it out of the route handler made it directly
// testable. Disposable org, cleaned up via cascade delete.

const utcDate = (isoDate: string): Date => new Date(`${isoDate}T00:00:00.000Z`);

interface Fixture {
  organizationId: string;
  employeeId: string;
  leaveTypeId: string;
}

const withFixture = async (accruedDays: string, run: (fixture: Fixture) => Promise<void>) => {
  const organization = await prisma.organization.create({
    data: { id: randomUUID(), name: "Leave Svc Co", slug: `leave-svc-${randomUUID()}`, createdAt: new Date() },
  });
  try {
    const employee = await prisma.employee.create({
      data: {
        organizationId: organization.id,
        fullName: "Test Employee",
        email: `leave-svc-${randomUUID()}@example.com`,
        role: "EMPLOYEE",
      },
    });
    const leaveType = await prisma.leaveType.create({
      data: { organizationId: organization.id, name: "Casual Leave", code: "CL", accrualPerMonth: "1", annualCap: 12 },
    });
    await prisma.leaveBalance.create({
      data: {
        organizationId: organization.id,
        employeeId: employee.id,
        leaveTypeId: leaveType.id,
        year: 2026,
        accruedDays,
      },
    });
    await run({ organizationId: organization.id, employeeId: employee.id, leaveTypeId: leaveType.id });
  } finally {
    await prisma.organization.delete({ where: { id: organization.id } });
  }
};

const submitParams = (fixture: Fixture, startDate: string, endDate: string) => ({
  ...fixture,
  startDate: utcDate(startDate),
  endDate: utcDate(endDate),
  isHalfDay: false,
});

test("approving deducts usedDays by exactly the request's workingDays", async () => {
  await withFixture("5", async (fixture) => {
    // Wed Mar 4 -> Thu Mar 5 = 2 working days.
    const submitted = await submitLeaveRequest(prisma, submitParams(fixture, "2026-03-04", "2026-03-05"));
    assert.equal(submitted.workingDays.toNumber(), 2);
    assert.equal(submitted.status, "PENDING");

    // Still only reserved at this point — nothing deducted yet.
    let balance = await prisma.leaveBalance.findFirstOrThrow({ where: { employeeId: fixture.employeeId } });
    assert.equal(balance.usedDays.toNumber(), 0, "a pending request reserves but must not deduct");

    await approveLeaveRequest(prisma, {
      id: submitted.id,
      organizationId: fixture.organizationId,
      approverEmployeeId: fixture.employeeId,
    });

    balance = await prisma.leaveBalance.findFirstOrThrow({ where: { employeeId: fixture.employeeId } });
    assert.equal(balance.usedDays.toNumber(), 2, "approval deducts the stored workingDays");
  });
});

test("rejecting frees the reservation without deducting", async () => {
  await withFixture("5", async (fixture) => {
    const submitted = await submitLeaveRequest(prisma, submitParams(fixture, "2026-03-04", "2026-03-05"));
    const rejected = await rejectLeaveRequest(prisma, {
      id: submitted.id,
      organizationId: fixture.organizationId,
      approverEmployeeId: fixture.employeeId,
      decisionNote: "Not this week",
    });

    assert.equal(rejected.status, "REJECTED");
    const balance = await prisma.leaveBalance.findFirstOrThrow({ where: { employeeId: fixture.employeeId } });
    assert.equal(balance.usedDays.toNumber(), 0, "reject must never touch usedDays");
  });
});

test("a weekend-only range is rejected as having no working days", async () => {
  await withFixture("5", async (fixture) => {
    await assert.rejects(
      () => submitLeaveRequest(prisma, submitParams(fixture, "2026-03-07", "2026-03-08")),
      (err: unknown) => err instanceof AppError && err.statusCode === 400,
    );
  });
});

test("a second request overlapping an existing pending one is rejected", async () => {
  await withFixture("20", async (fixture) => {
    await submitLeaveRequest(prisma, submitParams(fixture, "2026-03-04", "2026-03-05"));
    await assert.rejects(
      () => submitLeaveRequest(prisma, submitParams(fixture, "2026-03-05", "2026-03-06")),
      (err: unknown) => err instanceof AppError && err.statusCode === 409 && /overlap/i.test(err.message),
    );
  });
});

test("a floater leave type only accepts a single day that is a listed optional holiday", async () => {
  const organization = await prisma.organization.create({
    data: { id: randomUUID(), name: "Floater Leave Co", slug: `floater-leave-${randomUUID()}`, createdAt: new Date() },
  });
  try {
    const employee = await prisma.employee.create({
      data: {
        organizationId: organization.id,
        fullName: "Test Employee",
        email: `floater-leave-${randomUUID()}@example.com`,
        role: "EMPLOYEE",
      },
    });
    const leaveType = await prisma.leaveType.create({
      data: {
        organizationId: organization.id,
        name: "Floater Holiday",
        code: "FLOATER",
        accrualPerMonth: "0",
        annualCap: 2,
        allocationType: "ANNUAL_GRANT",
        annualGrantDays: "2",
        allowHalfDay: false,
        isFloater: true,
      },
    });
    await prisma.leaveBalance.create({
      data: { organizationId: organization.id, employeeId: employee.id, leaveTypeId: leaveType.id, year: 2026, accruedDays: "2" },
    });
    const optionalDate = utcDate("2026-03-05");
    await prisma.holiday.create({
      data: { organizationId: organization.id, date: optionalDate, name: "Optional Day", year: 2026, isOptional: true },
    });

    const params = { organizationId: organization.id, employeeId: employee.id, leaveTypeId: leaveType.id };

    // Not a listed optional holiday -> rejected.
    await assert.rejects(
      () =>
        submitLeaveRequest(prisma, {
          ...params,
          startDate: utcDate("2026-03-06"),
          endDate: utcDate("2026-03-06"),
          isHalfDay: false,
        }),
      (err: unknown) => err instanceof AppError && err.statusCode === 400 && /optional holiday/i.test(err.message),
    );

    // A range (even one that includes the optional date) -> rejected.
    await assert.rejects(
      () =>
        submitLeaveRequest(prisma, {
          ...params,
          startDate: utcDate("2026-03-04"),
          endDate: optionalDate,
          isHalfDay: false,
        }),
      (err: unknown) => err instanceof AppError && err.statusCode === 400 && /single day/i.test(err.message),
    );

    // Half-day -> rejected, even on the optional date itself. (Caught by the
    // leave type's own allowHalfDay: false before reaching the floater-only
    // single-day check, but either way it's a 400.)
    await assert.rejects(
      () => submitLeaveRequest(prisma, { ...params, startDate: optionalDate, endDate: optionalDate, isHalfDay: true }),
      (err: unknown) => err instanceof AppError && err.statusCode === 400,
    );

    // The actual listed optional-holiday date, as a single full day -> accepted.
    const submitted = await submitLeaveRequest(prisma, {
      ...params,
      startDate: optionalDate,
      endDate: optionalDate,
      isHalfDay: false,
    });
    assert.equal(submitted.workingDays.toNumber(), 1, "an optional holiday counts as a normal working day");
  } finally {
    await prisma.organization.delete({ where: { id: organization.id } });
  }
});

test("the reservation rule blocks a second request that exceeds the remaining balance", async () => {
  // 3 days accrued. First request takes 2 (pending, not yet approved).
  // A second non-overlapping 2-day request must not fit in the remaining 1.
  await withFixture("3", async (fixture) => {
    await submitLeaveRequest(prisma, submitParams(fixture, "2026-03-04", "2026-03-05"));
    await assert.rejects(
      () => submitLeaveRequest(prisma, submitParams(fixture, "2026-03-11", "2026-03-12")),
      (err: unknown) => err instanceof AppError && err.statusCode === 409 && /balance/i.test(err.message),
      "pending reservations must count against available balance",
    );
  });
});
