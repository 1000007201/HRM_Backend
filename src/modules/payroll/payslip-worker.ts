import type { PgBoss } from "pg-boss";
import { prisma } from "../../core/prisma.js";
import { sendEmail } from "../../core/email.js";
import { generateAndStorePayslipPdf } from "./payslips.service.js";
import { PAYSLIP_BATCH_TRIGGER_QUEUE, PAYSLIP_GENERATE_AND_EMAIL_QUEUE } from "../../lib/queue.js";

export interface PayslipJobData {
  payslipId: string;
  payrollRunId: string;
  organizationId: string;
  sendEmail: boolean;
}

export interface BatchTriggerJobData {
  payrollRunId: string;
  organizationId: string;
  // Not in the original spec's BatchTriggerJobData, but required to satisfy
  // its own regenerate-pdfs requirement ("sendEmail: false ... regeneration
  // shouldn't spam employees") — the batch job has to carry this so it can
  // forward it to every individual job it fans out.
  sendEmail: boolean;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

const formatInr = (amount: number): string => `₹${amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const buildPayslipEmailHtml = (params: { employeeFirstName: string; monthName: string; year: number; orgName: string; grossEarnings: number; totalDeductions: number; netPay: number }): string => {
  const { employeeFirstName, monthName, year, orgName, grossEarnings, totalDeductions, netPay } = params;
  return `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #333;">Payslip — ${monthName} ${year}</h2>
  <p>Hi ${employeeFirstName},</p>
  <p>Your payslip for <strong>${monthName} ${year}</strong> has been processed.</p>
  <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
    <tr>
      <td style="padding: 8px; border: 1px solid #ddd;">Gross Earnings</td>
      <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">${formatInr(grossEarnings)}</td>
    </tr>
    <tr>
      <td style="padding: 8px; border: 1px solid #ddd;">Total Deductions</td>
      <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">${formatInr(totalDeductions)}</td>
    </tr>
    <tr style="font-weight: bold;">
      <td style="padding: 8px; border: 1px solid #ddd;">Net Pay</td>
      <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">${formatInr(netPay)}</td>
    </tr>
  </table>
  <p>Your detailed payslip is attached as a PDF. You can also view and download it anytime from the HR portal.</p>
  <p style="color: #666; font-size: 12px; margin-top: 30px;">
    This is an automated email from ${orgName}. Please do not reply.
  </p>
</div>`.trim();
};

export function registerPayslipWorkers(boss: PgBoss) {
  // batchSize: 1 so a thrown error only fails/retries that one job — never
  // the whole fetched batch — which is what makes "one employee's PDF fails,
  // others still succeed" true without needing pg-boss's perJobResults
  // bookkeeping. localConcurrency: 2 runs two of these at a time (the
  // "teamSize: 5, teamConcurrency: 2" from the spec, adapted to pg-boss
  // v12's renamed options — see the version note in src/lib/queue.ts).
  boss.work<PayslipJobData>(PAYSLIP_GENERATE_AND_EMAIL_QUEUE, { batchSize: 1, localConcurrency: 2 }, async ([job]) => {
    if (!job) return;
    const { payslipId, organizationId, sendEmail: shouldEmail } = job.data;

    const generated = await generateAndStorePayslipPdf(prisma, { organizationId, payslipId });

    if (shouldEmail && generated.employeeEmail) {
      const monthName = MONTH_NAMES[generated.month - 1] ?? String(generated.month);
      const organization = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true } });
      const payslip = await prisma.payslip.findUniqueOrThrow({ where: { id: payslipId }, select: { grossEarnings: true, totalDeductions: true, netPay: true } });

      // Email failure must not fail the job — the PDF is already saved, so
      // the employee can still download it from the portal even if this
      // send fails (rate limit, bad address, provider outage, ...).
      try {
        await sendEmail({
          to: generated.employeeEmail,
          subject: `Payslip for ${monthName} ${generated.year} — ${organization.name}`,
          html: buildPayslipEmailHtml({
            employeeFirstName: generated.employeeName.split(" ")[0] ?? generated.employeeName,
            monthName,
            year: generated.year,
            orgName: organization.name,
            grossEarnings: payslip.grossEarnings.toNumber(),
            totalDeductions: payslip.totalDeductions.toNumber(),
            netPay: payslip.netPay.toNumber(),
          }),
          attachments: [{ filename: generated.fileName, content: generated.pdfBuffer }],
        });
      } catch (error) {
        console.error(`[payslip-worker] email failed for payslip ${payslipId}:`, error);
      }
    }
  });

  boss.work<BatchTriggerJobData>(PAYSLIP_BATCH_TRIGGER_QUEUE, async ([job]) => {
    if (!job) return;
    const { payrollRunId, organizationId, sendEmail: shouldEmail } = job.data;

    const payslips = await prisma.payslip.findMany({
      where: { payrollRunId, payrollRun: { organizationId } },
      select: { id: true },
    });
    if (payslips.length === 0) return;

    await boss.insert(
      PAYSLIP_GENERATE_AND_EMAIL_QUEUE,
      payslips.map((payslip) => ({
        data: { payslipId: payslip.id, payrollRunId, organizationId, sendEmail: shouldEmail } satisfies PayslipJobData,
      })),
    );
  });
}
