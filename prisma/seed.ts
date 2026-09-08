import { prisma } from "../src/core/prisma.js";
import { registerCompany } from "../src/modules/identity/registerCompany.js";
import { ensureDefaultDepartments } from "../src/modules/departments/departments.js";
import type { EmployeeRole } from "../src/generated/prisma/client.js";

const DEMO_COMPANY_NAME = process.env.DEMO_COMPANY_NAME ?? "Acme Demo Co";
const DEMO_ADMIN_NAME = process.env.DEMO_ADMIN_NAME ?? "Demo Admin";
const DEMO_ADMIN_EMAIL = process.env.DEMO_ADMIN_EMAIL ?? "admin@demo.hrm.local";
const DEMO_ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD ?? "DemoPassword123!";

// EmployeeRole is now just ADMIN/EMPLOYEE (HR and MANAGER were folded into
// those two — see the migration in prisma/migrations/20260906150001_reduce_employee_role_enum).
// The previously-HR demo employee becomes ADMIN; previously-MANAGER ones
// become EMPLOYEE, same as the rule applied to real data. managerId reporting
// lines are untouched — they're independent of role/permissions.
//
// Remaining 9 employees (admin below makes 10). managerName/departmentName
// are resolved to ids after creation, so the org chart and department
// assignment can be declared in one readable list.
const DEMO_EMPLOYEES: {
  fullName: string;
  email: string;
  role: EmployeeRole;
  designation: string;
  managerName: string | null;
  departmentName: string;
}[] = [
  { fullName: "Priya Sharma", email: "priya.sharma@demo.hrm.local", role: "ADMIN", designation: "HR Manager", managerName: DEMO_ADMIN_NAME, departmentName: "Human Resources" },
  { fullName: "Rohan Verma", email: "rohan.verma@demo.hrm.local", role: "EMPLOYEE", designation: "Engineering Manager", managerName: DEMO_ADMIN_NAME, departmentName: "Engineering" },
  { fullName: "Ananya Iyer", email: "ananya.iyer@demo.hrm.local", role: "EMPLOYEE", designation: "Sales Manager", managerName: DEMO_ADMIN_NAME, departmentName: "Sales" },
  { fullName: "Karan Mehta", email: "karan.mehta@demo.hrm.local", role: "EMPLOYEE", designation: "Software Engineer", managerName: "Rohan Verma", departmentName: "Engineering" },
  { fullName: "Neha Gupta", email: "neha.gupta@demo.hrm.local", role: "EMPLOYEE", designation: "Software Engineer", managerName: "Rohan Verma", departmentName: "Engineering" },
  { fullName: "Arjun Nair", email: "arjun.nair@demo.hrm.local", role: "EMPLOYEE", designation: "QA Engineer", managerName: "Rohan Verma", departmentName: "Engineering" },
  { fullName: "Sneha Reddy", email: "sneha.reddy@demo.hrm.local", role: "EMPLOYEE", designation: "Sales Executive", managerName: "Ananya Iyer", departmentName: "Sales" },
  { fullName: "Vikram Singh", email: "vikram.singh@demo.hrm.local", role: "EMPLOYEE", designation: "Sales Executive", managerName: "Ananya Iyer", departmentName: "Sales" },
  { fullName: "Ishita Kapoor", email: "ishita.kapoor@demo.hrm.local", role: "EMPLOYEE", designation: "HR Executive", managerName: "Priya Sharma", departmentName: "Human Resources" },
];

// DEMO_EMPLOYEES is ordered so a manager always appears before their
// reports, so resolving managerName -> id in a single left-to-right pass
// (seeded from whatever already exists in the org) always finds it.
const seedEmployees = async (organizationId: string, toCreate: typeof DEMO_EMPLOYEES) => {
  const nameToId = new Map<string, string>(
    (await prisma.employee.findMany({ where: { organizationId }, select: { id: true, fullName: true } })).map(
      (e) => [e.fullName, e.id],
    ),
  );
  const departmentIdByName = new Map(
    (await prisma.department.findMany({ where: { organizationId }, select: { id: true, name: true } })).map((d) => [
      d.name,
      d.id,
    ]),
  );

  for (const { fullName, email, role, designation, managerName, departmentName } of toCreate) {
    const managerId = managerName ? nameToId.get(managerName) : undefined;
    const departmentId = departmentIdByName.get(departmentName);
    const employee = await prisma.employee.create({
      data: { organizationId, fullName, email, role, designation, managerId, departmentId, joiningDate: new Date() },
    });
    nameToId.set(fullName, employee.id);
  }
};

const main = async () => {
  const existingAdmin = await prisma.user.findUnique({ where: { email: DEMO_ADMIN_EMAIL } });
  const existingAdminEmployee = existingAdmin
    ? await prisma.employee.findFirst({ where: { userId: existingAdmin.id } })
    : null;

  const organizationId = existingAdminEmployee
    ? existingAdminEmployee.organizationId
    : (await registerCompany({
        companyName: DEMO_COMPANY_NAME,
        fullName: DEMO_ADMIN_NAME,
        email: DEMO_ADMIN_EMAIL,
        password: DEMO_ADMIN_PASSWORD,
      }).then((r) => r.organization.id));

  // registerCompany already seeds the default department set for a brand new
  // org; calling it again here is a no-op upsert, so this also covers the
  // "org already existed from a previous seed run" path.
  await ensureDefaultDepartments(organizationId);

  // Exercises the new optional profile fields on the demo admin — idempotent,
  // same values every run.
  const administrationDepartment = await prisma.department.findUnique({
    where: { organizationId_name: { organizationId, name: "Administration" } },
  });
  await prisma.employee.updateMany({
    where: { organizationId, email: DEMO_ADMIN_EMAIL },
    data: { departmentId: administrationDepartment?.id, employeeCode: "EMP-0001", phone: "+91-9800000001" },
  });

  // Top up any employees missing from a previous partial/older seed run —
  // each is looked up by its unique (organizationId, email).
  const existingEmails = new Set(
    (await prisma.employee.findMany({ where: { organizationId }, select: { email: true } })).map((e) => e.email),
  );
  const missing = DEMO_EMPLOYEES.filter((e) => !existingEmails.has(e.email));
  if (missing.length > 0) {
    await seedEmployees(organizationId, missing);
  }

  const total = await prisma.employee.count({ where: { organizationId } });
  console.log(
    `Seed: demo company ready (organizationId=${organizationId}), admin ${DEMO_ADMIN_EMAIL} / password "${DEMO_ADMIN_PASSWORD}", ${total} employees total (${missing.length} newly created).`,
  );
};

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
