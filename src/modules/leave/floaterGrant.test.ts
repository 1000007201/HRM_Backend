import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../core/prisma.js";
import { grantAnnualForOrg } from "./floaterGrant.js";

// The property that makes ANNUAL_GRANT safe to run from a daily/monthly poll:
// re-running the same year never re-grants or stacks accruedDays.
test("grantAnnualForOrg grants the full amount once, and re-running the same year is a no-op", async () => {
  const organization = await prisma.organization.create({
    data: { id: randomUUID(), name: "Floater Grant Co", slug: `floater-grant-${randomUUID()}`, createdAt: new Date() },
  });
  try {
    const employee = await prisma.employee.create({
      data: {
        organizationId: organization.id,
        fullName: "Test Employee",
        email: `floater-grant-${randomUUID()}@example.com`,
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

    const first = await grantAnnualForOrg(organization.id, 2026);
    assert.equal(first.employeesGranted, 1);
    assert.equal(first.employeesSkipped, 0);

    let balance = await prisma.leaveBalance.findUniqueOrThrow({
      where: { employeeId_leaveTypeId_year: { employeeId: employee.id, leaveTypeId: leaveType.id, year: 2026 } },
    });
    assert.equal(balance.accruedDays.toNumber(), 2);

    // Simulate usage, then re-run the same year's grant — it must not top the
    // balance back up (that would defeat "use it or lose it").
    await prisma.leaveBalance.update({ where: { id: balance.id }, data: { usedDays: 1 } });
    const second = await grantAnnualForOrg(organization.id, 2026);
    assert.equal(second.employeesGranted, 0);
    assert.equal(second.employeesSkipped, 1);

    balance = await prisma.leaveBalance.findUniqueOrThrow({ where: { id: balance.id } });
    assert.equal(balance.accruedDays.toNumber(), 2, "re-running must not stack accruedDays");
    assert.equal(balance.usedDays.toNumber(), 1, "re-running must not touch usedDays either");
  } finally {
    await prisma.organization.delete({ where: { id: organization.id } });
  }
});

test("grantAnnualForOrg skips an employee who joins after the granted year ends", async () => {
  const organization = await prisma.organization.create({
    data: { id: randomUUID(), name: "Floater Grant Skip Co", slug: `floater-grant-skip-${randomUUID()}`, createdAt: new Date() },
  });
  try {
    await prisma.employee.create({
      data: {
        organizationId: organization.id,
        fullName: "Future Joiner",
        email: `floater-grant-skip-${randomUUID()}@example.com`,
        role: "EMPLOYEE",
        joiningDate: new Date("2027-01-15T00:00:00.000Z"),
      },
    });
    await prisma.leaveType.create({
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

    const result = await grantAnnualForOrg(organization.id, 2026);
    assert.equal(result.employeesProcessed, 0, "not yet joined by the end of 2026");
    assert.equal(result.employeesGranted, 0);
  } finally {
    await prisma.organization.delete({ where: { id: organization.id } });
  }
});
