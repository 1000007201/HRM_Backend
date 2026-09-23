import fs from "node:fs/promises";
import path from "node:path";

const STORAGE_ROOT = path.resolve(process.cwd(), "storage");

// {organizationId}/{year}-{month:2digits}/{employeeId}.pdf — organizationId
// segments the path per tenant the same way every uploads/ dir in this
// codebase already segments by feature, so a stray path bug can't cross a
// tenant boundary even before the DB scoping is checked.
export async function savePayslipPdf(orgId: string, year: number, month: number, employeeId: string, pdfBuffer: Buffer): Promise<string> {
  const monthStr = String(month).padStart(2, "0");
  const dir = path.join(STORAGE_ROOT, "payslips", orgId, `${year}-${monthStr}`);
  await fs.mkdir(dir, { recursive: true });

  const filename = `${employeeId}.pdf`;
  await fs.writeFile(path.join(dir, filename), pdfBuffer);

  return `payslips/${orgId}/${year}-${monthStr}/${filename}`;
}

export function getAbsolutePdfPath(relativePath: string): string {
  return path.join(STORAGE_ROOT, relativePath);
}
