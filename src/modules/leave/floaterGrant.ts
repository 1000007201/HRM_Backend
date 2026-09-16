import { prisma } from "../../core/prisma.js";
import { LeaveAllocationType } from "../../generated/prisma/client.js";

export interface GrantRunResult {
  year: number;
  employeesProcessed: number;
  employeesGranted: number;
  employeesSkipped: number;
  employeesFailed: number;
}

// Last instant of `year`, local time — used only to decide "has this
// employee joined by the end of this year yet", same reasoning as
// accrual.ts's endOfMonth.
const endOfYear = (year: number): Date => new Date(year, 11, 31, 23, 59, 59, 999);

// Runs the annual grant for one org, parallel to accrueForOrg (accrual.ts)
// but for ANNUAL_GRANT leave types instead of MONTHLY_ACCRUAL ones. For each
// employee eligible by joiningDate and each active ANNUAL_GRANT LeaveType,
// creates a LeaveBalance(employee, leaveType, year) row with
// accruedDays = annualGrantDays — but ONLY if that row doesn't already exist,
// which is what makes re-running the same year a no-op instead of
// re-granting or stacking. Unlike accrual there is nothing to increment: an
// ANNUAL_GRANT balance is set once, in full, on first grant.
//
// TODO: grants the full annualGrantDays regardless of when in the year the
// employee joined. Proration by joiningDate is a future policy option, not
// implemented here.
export const grantAnnualForOrg = async (organizationId: string, year: number): Promise<GrantRunResult> => {
  const [employees, leaveTypes] = await Promise.all([
    prisma.employee.findMany({
      where: { organizationId, isActive: true },
      select: { id: true, joiningDate: true },
    }),
    prisma.leaveType.findMany({
      where: { organizationId, isActive: true, allocationType: LeaveAllocationType.ANNUAL_GRANT },
    }),
  ]);

  const cutoff = endOfYear(year);
  const result: GrantRunResult = {
    year,
    employeesProcessed: 0,
    employeesGranted: 0,
    employeesSkipped: 0,
    employeesFailed: 0,
  };

  if (leaveTypes.length === 0) {
    return result;
  }

  for (const employee of employees) {
    // Not yet joined by the end of this year — joiningDate null means
    // "always eligible" (pre-existing employees with no recorded date).
    if (employee.joiningDate && employee.joiningDate > cutoff) {
      continue;
    }
    result.employeesProcessed += 1;

    try {
      const { granted, skipped } = await prisma.$transaction(async (tx) => {
        let granted = 0;
        let skipped = 0;

        for (const leaveType of leaveTypes) {
          const existing = await tx.leaveBalance.findUnique({
            where: { employeeId_leaveTypeId_year: { employeeId: employee.id, leaveTypeId: leaveType.id, year } },
          });
          if (existing) {
            skipped += 1;
            continue;
          }

          await tx.leaveBalance.create({
            data: {
              organizationId,
              employeeId: employee.id,
              leaveTypeId: leaveType.id,
              year,
              accruedDays: leaveType.annualGrantDays ?? 0,
            },
          });
          granted += 1;
        }

        return { granted, skipped };
      });

      result.employeesGranted += granted;
      result.employeesSkipped += skipped;
    } catch (err) {
      result.employeesFailed += 1;
      console.error(`[floaterGrant] grant failed for employee=${employee.id} org=${organizationId} year=${year}`, err);
    }
  }

  return result;
};

// Runs grantAnnualForOrg for every org, for the given year — this is what the
// shared-secret system endpoint / scheduler calls, parallel to
// accrueForAllOrgs.
export const grantAnnualForAllOrgs = async (year: number): Promise<GrantRunResult[]> => {
  const organizations = await prisma.organization.findMany({ select: { id: true } });
  const results: GrantRunResult[] = [];
  for (const organization of organizations) {
    results.push(await grantAnnualForOrg(organization.id, year));
  }
  return results;
};
