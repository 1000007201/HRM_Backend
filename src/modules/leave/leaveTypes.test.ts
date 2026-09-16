import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../core/prisma.js";
import { AppError } from "../../core/errors.js";
import { ensureFloaterLeaveType, updateFloaterQuota } from "./leaveTypes.js";
import { grantAnnualForOrg } from "./floaterGrant.js";

// The org-configurable floater quota: an ADMIN can raise/lower how many
// floater days an employee gets a year, and it must take effect immediately
// for anyone already granted this year — not just next year's grant.
test("updateFloaterQuota changes the type AND re-syncs already-granted current-year balances", async () => {
  const organization = await prisma.organization.create({
    data: { id: randomUUID(), name: "Floater Quota Co", slug: `floater-quota-${randomUUID()}`, createdAt: new Date() },
  });
  try {
    const employee = await prisma.employee.create({
      data: {
        organizationId: organization.id,
        fullName: "Test Employee",
        email: `floater-quota-${randomUUID()}@example.com`,
        role: "EMPLOYEE",
      },
    });
    await ensureFloaterLeaveType(organization.id);
    const year = new Date().getFullYear();
    await grantAnnualForOrg(organization.id, year);

    let balance = await prisma.leaveBalance.findFirstOrThrow({ where: { organizationId: organization.id, employeeId: employee.id, year } });
    assert.equal(balance.accruedDays.toNumber(), 2, "seeded default is 2");

    // Simulate the employee having already used one of their two days.
    await prisma.leaveBalance.update({ where: { id: balance.id }, data: { usedDays: 1 } });

    const updated = await updateFloaterQuota(organization.id, 3);
    assert.equal(updated.annualGrantDays?.toString(), "3");
    assert.equal(updated.annualCap, 3);

    balance = await prisma.leaveBalance.findUniqueOrThrow({ where: { id: balance.id } });
    assert.equal(balance.accruedDays.toNumber(), 3, "existing current-year balance is re-synced to the new quota");
    assert.equal(balance.usedDays.toNumber(), 1, "already-used days are untouched");

    // A later grant run (e.g. next year) must use the new quota, not the old one.
    const nextYearResult = await grantAnnualForOrg(organization.id, year + 1);
    assert.equal(nextYearResult.employeesGranted, 1);
    const nextYearBalance = await prisma.leaveBalance.findFirstOrThrow({
      where: { organizationId: organization.id, employeeId: employee.id, year: year + 1 },
    });
    assert.equal(nextYearBalance.accruedDays.toNumber(), 3);
  } finally {
    await prisma.organization.delete({ where: { id: organization.id } });
  }
});

test("updateFloaterQuota 404s for an org with no floater leave type", async () => {
  const organization = await prisma.organization.create({
    data: { id: randomUUID(), name: "No Floater Co", slug: `no-floater-${randomUUID()}`, createdAt: new Date() },
  });
  try {
    await assert.rejects(
      () => updateFloaterQuota(organization.id, 3),
      (err: unknown) => err instanceof AppError && err.statusCode === 404,
    );
  } finally {
    await prisma.organization.delete({ where: { id: organization.id } });
  }
});
