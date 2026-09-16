import { prisma } from "../../core/prisma.js";
import { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../core/errors.js";

// Reasonable Indian SME defaults: Casual, Sick, Earned leave. `code` is the
// per-org unique key (LeaveType.organizationId_code) — ensureDefaultLeaveTypes
// upserts on it, so re-running (or calling it for an org that already has
// these) never duplicates or overwrites an admin's later edits.
const DEFAULT_LEAVE_TYPES = [
  { code: "CL", name: "Casual Leave", accrualPerMonth: "1", annualCap: 12 },
  { code: "SL", name: "Sick Leave", accrualPerMonth: "1", annualCap: 12 },
  { code: "EL", name: "Earned Leave", accrualPerMonth: "1.5", annualCap: 18 },
] as const;

// Called once at company registration so every new org starts with CL/SL/EL.
// Safe to call again for an existing org — upsert's `update: {}` is a no-op
// when the row already exists, so it never clobbers an admin's edits
// (renamed type, changed cap, etc). All three default to allocationType
// MONTHLY_ACCRUAL and isFloater false via the schema, so nothing extra needs
// to be passed here.
export const ensureDefaultLeaveTypes = async (organizationId: string): Promise<void> => {
  await Promise.all(
    DEFAULT_LEAVE_TYPES.map((leaveType) =>
      prisma.leaveType.upsert({
        where: { organizationId_code: { organizationId, code: leaveType.code } },
        create: { organizationId, ...leaveType },
        update: {},
      }),
    ),
  );
};

// The org-wide floater/optional-holiday leave type. Not exposed through
// POST /leave/types (the admin-facing custom-type form) — it's a single
// seeded type per org, granted a flat amount once a year by
// grantAnnualForOrg (floaterGrant.ts) rather than accrued monthly.
// accrualPerMonth/annualCap are unused on the ANNUAL_GRANT path (see the
// LeaveAllocationType comment in schema.prisma) but stay required columns,
// so they're set equal to annualGrantDays.
const FLOATER_LEAVE_TYPE = {
  code: "FLOATER",
  name: "Floater Holiday",
  annualGrantDaysNumber: 2,
} as const;

// Called at company registration (and safe to re-run, e.g. from the seed
// script) so every org has exactly the one floater leave type. Upserts on
// `code` like ensureDefaultLeaveTypes, so it never clobbers an admin's edits.
export const ensureFloaterLeaveType = async (organizationId: string): Promise<void> => {
  await prisma.leaveType.upsert({
    where: { organizationId_code: { organizationId, code: FLOATER_LEAVE_TYPE.code } },
    create: {
      organizationId,
      name: FLOATER_LEAVE_TYPE.name,
      code: FLOATER_LEAVE_TYPE.code,
      accrualPerMonth: 0,
      annualCap: FLOATER_LEAVE_TYPE.annualGrantDaysNumber,
      allocationType: "ANNUAL_GRANT",
      annualGrantDays: FLOATER_LEAVE_TYPE.annualGrantDaysNumber,
      allowHalfDay: false,
      isFloater: true,
    },
    update: {},
  });
};

// Lets an ADMIN change the org's floater quota (the "2" in "2 floater leaves
// a year") after the fact — ensureFloaterLeaveType only ever sets it once, on
// first creation, and never overwrites it again. Updates the LeaveType
// itself (so next year's grantAnnualForOrg run uses the new number) AND every
// already-granted CURRENT-year balance (so the change is felt immediately,
// not just for people who haven't been granted yet) — grantAnnualForOrg's
// invariant is accruedDays === annualGrantDays for this type, so re-syncing
// existing rows to the new value keeps that invariant true rather than
// leaving them stuck on the old number for the rest of the year.
export const updateFloaterQuota = async (organizationId: string, annualGrantDays: number) => {
  return prisma.$transaction(async (tx) => {
    const leaveType = await tx.leaveType.findUnique({
      where: { organizationId_code: { organizationId, code: FLOATER_LEAVE_TYPE.code } },
    });
    if (!leaveType) {
      throw new AppError(404, "NOT_FOUND", "This organization has no floater leave type");
    }

    const updated = await tx.leaveType.update({
      where: { id: leaveType.id },
      data: { annualGrantDays, annualCap: annualGrantDays },
      select: leaveTypeSelect,
    });

    await tx.leaveBalance.updateMany({
      where: { organizationId, leaveTypeId: leaveType.id, year: new Date().getFullYear() },
      data: { accruedDays: annualGrantDays },
    });

    return updated;
  });
};

export type LeaveAccrualFrequency = "ANNUAL" | "MONTHLY";

export interface CreateLeaveTypeInput {
  organizationId: string;
  name: string;
  code: string;
  annualCap: number;
  accrualFrequency: LeaveAccrualFrequency;
  isPaid: boolean;
  allowHalfDay: boolean;
}

export const leaveTypeSelect = {
  id: true,
  name: true,
  code: true,
  accrualPerMonth: true,
  annualCap: true,
  isPaid: true,
  allowHalfDay: true,
  allocationType: true,
  annualGrantDays: true,
  isFloater: true,
} as const;

// There's no separate "frequency" column for MONTHLY_ACCRUAL types —
// accrueForOrg (accrual.ts) already credits min(accrualPerMonth, remaining)
// each month, so ANNUAL is just the degenerate case accrualPerMonth ==
// annualCap: the whole cap is exhausted on the first run. MONTHLY spreads it
// evenly over the year. This endpoint only ever creates MONTHLY_ACCRUAL
// types — the floater type is seeded separately via ensureFloaterLeaveType.
export const createLeaveType = (input: CreateLeaveTypeInput) => {
  const accrualPerMonth =
    input.accrualFrequency === "ANNUAL"
      ? new Prisma.Decimal(input.annualCap)
      : new Prisma.Decimal(input.annualCap).dividedBy(12).toDecimalPlaces(2);

  return prisma.leaveType.create({
    data: {
      organizationId: input.organizationId,
      name: input.name,
      code: input.code,
      annualCap: input.annualCap,
      accrualPerMonth,
      isPaid: input.isPaid,
      allowHalfDay: input.allowHalfDay,
    },
    select: leaveTypeSelect,
  });
};
