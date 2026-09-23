import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { STATUTORY_COMPONENT_NAMES } from "./engine.js";

type Db = PrismaClient | Prisma.TransactionClient;

export interface YtdFigures {
  ytdEarnings: number;
  ytdTdsDeducted: number;
}

// FY start (April) of the year that contains (month, year).
const fyStartYear = (month: number, year: number): number => (month >= 4 ? year : year - 1);

// Only APPROVED/PAID runs count — the run currently being processed is still
// DRAFT/PROCESSING/REVIEW at this point, so it's naturally excluded without
// needing a separate "before this month" filter.
export const getYtdFigures = async (
  db: Db,
  params: { organizationId: string; employeeId: string; month: number; year: number },
): Promise<YtdFigures> => {
  const { organizationId, employeeId, month, year } = params;
  const startYear = fyStartYear(month, year);

  const payslips = await db.payslip.findMany({
    where: {
      employeeId,
      payrollRun: {
        organizationId,
        status: { in: ["APPROVED", "PAID"] },
        OR: [
          { year: startYear, month: { gte: 4 } },
          { year: startYear + 1, month: { lte: 3 } },
        ],
      },
    },
    select: { grossEarnings: true, components: { where: { name: STATUTORY_COMPONENT_NAMES.TDS }, select: { amount: true } } },
  });

  let ytdEarnings = 0;
  let ytdTdsDeducted = 0;
  for (const payslip of payslips) {
    ytdEarnings += payslip.grossEarnings.toNumber();
    for (const component of payslip.components) {
      ytdTdsDeducted += component.amount.toNumber();
    }
  }

  return { ytdEarnings, ytdTdsDeducted };
};
