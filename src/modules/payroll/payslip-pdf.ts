import path from "node:path";
import pdfMake from "pdfmake";
import type { Content, TableCell } from "pdfmake/interfaces.js";

// pdfmake 0.3.x's Node entry point is a singleton with setFonts()/createPdf()
// — not the older PdfPrinter class API. Fonts are loaded from its own
// bundled Roboto TTFs rather than shipping our own font files.
const ROBOTO_DIR = path.join(process.cwd(), "node_modules", "pdfmake", "build", "fonts", "Roboto");
pdfMake.setFonts({
  Roboto: {
    normal: path.join(ROBOTO_DIR, "Roboto-Regular.ttf"),
    bold: path.join(ROBOTO_DIR, "Roboto-Medium.ttf"),
    italics: path.join(ROBOTO_DIR, "Roboto-Italic.ttf"),
    bolditalics: path.join(ROBOTO_DIR, "Roboto-MediumItalic.ttf"),
  },
});
// A payslip's content is built entirely from strings/numbers we already
// control — never a URL a caller could smuggle in — so that's denied
// outright. Local access has to stay open for exactly the bundled font
// files (pdfmake validates font paths through this same policy); anything
// else is denied. Also silences pdfmake's "no access policy defined"
// console warnings on every single PDF generated.
pdfMake.setUrlAccessPolicy(() => false);
pdfMake.setLocalAccessPolicy((filePath) => filePath.startsWith(ROBOTO_DIR));

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export const formatIndianCurrency = (amount: number): string => {
  const formatted = amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `₹${formatted}`;
};

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

const twoDigitWords = (value: number): string => {
  if (value < 20) return ONES[value] ?? "";
  const tens = Math.floor(value / 10);
  const ones = value % 10;
  return TENS[tens] + (ones ? ` ${ONES[ones]}` : "");
};

const threeDigitWords = (value: number): string => {
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  return [hundreds ? `${ONES[hundreds]} Hundred` : "", rest ? twoDigitWords(rest) : ""].filter(Boolean).join(" ");
};

// Indian numbering (lakh/thousand/hundred groups) — handles values up to
// ~99,99,999 per spec; a monthly payslip amount never realistically exceeds
// that, so crore handling is deliberately left out.
export const numberToWords = (amount: number): string => {
  const value = Math.round(Math.abs(amount));
  if (value === 0) return "Zero";

  const lakhs = Math.floor(value / 100000);
  const thousands = Math.floor((value % 100000) / 1000);
  const hundreds = value % 1000;

  return [
    lakhs ? `${twoDigitWords(lakhs)} Lakh` : "",
    thousands ? `${twoDigitWords(thousands)} Thousand` : "",
    hundreds ? threeDigitWords(hundreds) : "",
  ]
    .filter(Boolean)
    .join(" ");
};

export interface PayslipPdfLineItem {
  name: string;
  amount: number;
}

export interface PayslipPdfInput {
  orgName: string;
  employeeName: string;
  employeeCode: string;
  department: string | null;
  designation: string | null;
  month: number;
  year: number;
  daysInMonth: number;
  paidDays: number;
  lopDays: number;
  earnings: PayslipPdfLineItem[];
  employeeDeductions: PayslipPdfLineItem[];
  employerContributions: PayslipPdfLineItem[];
  grossEarnings: number;
  totalDeductions: number;
  netPay: number;
}

const detailCell = (label: string, value: string): Content => ({ text: [{ text: `${label}: `, bold: true }, value] });

const buildEarningsDeductionsTable = (earnings: PayslipPdfLineItem[], deductions: PayslipPdfLineItem[]): Content => {
  const rowCount = Math.max(earnings.length, deductions.length);
  const body: TableCell[][] = [
    [
      { text: "Earnings", bold: true },
      { text: "Amount", bold: true, alignment: "right" },
      { text: "Deductions", bold: true },
      { text: "Amount", bold: true, alignment: "right" },
    ],
  ];

  for (let i = 0; i < rowCount; i++) {
    const earning = earnings[i];
    const deduction = deductions[i];
    body.push([
      earning?.name ?? "",
      { text: earning ? formatIndianCurrency(earning.amount) : "", alignment: "right" },
      deduction?.name ?? "",
      { text: deduction ? formatIndianCurrency(deduction.amount) : "", alignment: "right" },
    ]);
  }

  return { table: { widths: ["*", "auto", "*", "auto"], body }, layout: "lightHorizontalLines" };
};

export async function generatePayslipPdf(input: PayslipPdfInput): Promise<Buffer> {
  const {
    orgName, employeeName, employeeCode, department, designation,
    month, year, daysInMonth, paidDays, lopDays,
    earnings, employeeDeductions, employerContributions,
    grossEarnings, totalDeductions, netPay,
  } = input;

  const content: Content[] = [
    { text: orgName, style: "orgName" },
    { text: `Payslip for ${MONTH_NAMES[month - 1] ?? month} ${year}`, style: "subtitle" },
    { canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1, lineColor: "#cccccc" }], margin: [0, 8, 0, 10] },
    {
      table: {
        widths: ["*", "*"],
        body: [
          [detailCell("Employee Name", employeeName), detailCell("Designation", designation ?? "—")],
          [detailCell("Employee Code", employeeCode), detailCell("Days in Month", String(daysInMonth))],
          [detailCell("Department", department ?? "—"), detailCell("Paid Days", String(paidDays))],
          ["", detailCell("LOP Days", String(lopDays))],
        ],
      },
      layout: "noBorders",
      margin: [0, 0, 0, 14],
    },
    buildEarningsDeductionsTable(earnings, employeeDeductions),
    {
      margin: [0, 6, 0, 0],
      table: {
        widths: ["*", "auto"],
        body: [
          [
            { text: "Gross Earnings", bold: true },
            { text: formatIndianCurrency(grossEarnings), bold: true, alignment: "right" },
          ],
          [
            { text: "Total Deductions", bold: true },
            { text: formatIndianCurrency(totalDeductions), bold: true, alignment: "right" },
          ],
        ],
      },
      layout: "noBorders",
    },
  ];

  if (employerContributions.length > 0) {
    content.push(
      { text: "Employer Contributions", style: "sectionHeading" },
      {
        table: {
          widths: ["*", "auto"],
          body: [
            [{ text: "Name", bold: true }, { text: "Amount", bold: true, alignment: "right" }],
            ...employerContributions.map((item): TableCell[] => [item.name, { text: formatIndianCurrency(item.amount), alignment: "right" }]),
          ],
        },
        layout: "lightHorizontalLines",
      },
    );
  }

  content.push(
    {
      margin: [0, 16, 0, 0],
      table: {
        widths: ["*", "auto"],
        body: [[{ text: "Net Pay", style: "netPay" }, { text: formatIndianCurrency(netPay), style: "netPay", alignment: "right" }]],
      },
      layout: { fillColor: () => "#f2f2f2", hLineWidth: () => 0, vLineWidth: () => 0, paddingTop: () => 6, paddingBottom: () => 6 },
    },
    { text: `Rupees ${numberToWords(netPay)} Only`, italics: true, fontSize: 8, margin: [0, 4, 0, 0] },
  );

  const pdfDoc = pdfMake.createPdf({
    pageSize: "A4",
    pageMargins: [40, 40, 40, 60],
    defaultStyle: { font: "Roboto", fontSize: 9 },
    styles: {
      orgName: { fontSize: 16, bold: true, alignment: "center" },
      subtitle: { fontSize: 11, alignment: "center", margin: [0, 4, 0, 0] },
      sectionHeading: { fontSize: 10, bold: true, margin: [0, 14, 0, 4] },
      netPay: { fontSize: 12, bold: true },
    },
    footer: {
      text: "This is a computer-generated payslip and does not require a signature.",
      fontSize: 7,
      color: "#666666",
      alignment: "center",
      margin: [0, 10, 0, 0],
    },
    content,
  });

  return pdfDoc.getBuffer();
}
