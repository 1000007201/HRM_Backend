import { prisma } from "../../core/prisma.js";
import { Prisma } from "../../generated/prisma/client.js";

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
// (renamed type, changed cap, etc).
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
} as const;

// There's no separate "frequency" column — accrueForOrg (accrual.ts) already
// credits min(accrualPerMonth, remaining) each month, so ANNUAL is just the
// degenerate case accrualPerMonth == annualCap: the whole cap is exhausted on
// the first run. MONTHLY spreads it evenly over the year.
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
