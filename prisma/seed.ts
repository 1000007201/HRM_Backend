import { randomUUID } from "node:crypto";
import { prisma } from "../src/core/prisma.js";
import { auth } from "../src/core/auth.js";
import { registerCompany } from "../src/modules/identity/registerCompany.js";
import { ensureDefaultDepartments } from "../src/modules/departments/departments.js";
import { ensureDefaultExpenseTypes } from "../src/modules/expenses/expenseTypes.js";
import { refreshRates } from "../src/modules/currency/exchangeRates.service.js";
import { ensureFloaterLeaveType } from "../src/modules/leave/leaveTypes.js";
import { grantAnnualForOrg } from "../src/modules/leave/floaterGrant.js";
import { toHolidayYear } from "../src/modules/holidays/holidays.js";
import type { EmployeeRole } from "../src/generated/prisma/client.js";

// A couple of optional (floater-eligible) holidays for the demo org, so the
// floater flow — GET /holidays/optional, applying for it, approving it — is
// testable end to end without hand-creating one first. Upserted by date like
// the rest of this file, so re-running the seed never duplicates them.
const DEMO_OPTIONAL_HOLIDAYS = [
  { date: "2026-03-04", name: "Holi (optional day)" },
  { date: "2026-10-21", name: "Diwali (optional day)" },
] as const;

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
      data: { organizationId, fullName, email, role, designation, managerId, departmentId, joiningDate: new Date(), isActive: true },
    });
    nameToId.set(fullName, employee.id);
  }
};

// ----- Two additional test organizations seeded from CSV sample data -----
// Employees are ordered managers-first so managerName resolves in one pass.

interface CsvEmployee {
  fullName: string;
  designation: string;
  departmentName: string;
  gender: string;
  joiningDate: string;
  managerName: string | null;
}

const toEmail = (fullName: string, domain: string) =>
  `${fullName.toLowerCase().replace(/\s+/g, ".")}@${domain}`;

const EXTRA_CSV_DEPARTMENTS = ["IT", "Finance", "Accounting"];

// NovaTech org chart:
// Ravi Kumar (Admin)
// ├── Wyatt Chin (VP Eng) → Camila Rogers, Abigail Mejia
// ├── David Barnes (Dir IT) → Ruby Barnes → Theodore Dinh, Penelope Jordan
// │                         → Elias Alvarado, Logan Rivera
// ├── Bella Powell (Dir Fin) → Everleigh Ng → Austin Vo, Madeline Walker
// │                          → Luna Sanders
// ├── Adam Dang (Dir Sales) → Mateo Her → Leonardo Dixon, Joshua Gupta
// │                         → Eva Rivera
// ├── Jose Henderson (Dir HR) → Savannah Ali, Eli Jones
// ├── Isabella Xi (VP Mktg) → Camila Silva
// └── Easton Bailey (Mgr Acctg)
const TEST_ORG_1_EMPLOYEES: CsvEmployee[] = [
  { fullName: "Wyatt Chin", designation: "Vice President", departmentName: "Engineering", gender: "Male", joiningDate: "2004-06-07", managerName: "Ravi Kumar" },
  { fullName: "David Barnes", designation: "Director", departmentName: "IT", gender: "Male", joiningDate: "2013-11-03", managerName: "Ravi Kumar" },
  { fullName: "Bella Powell", designation: "Director", departmentName: "Finance", gender: "Female", joiningDate: "2002-03-04", managerName: "Ravi Kumar" },
  { fullName: "Adam Dang", designation: "Director", departmentName: "Sales", gender: "Male", joiningDate: "2002-07-09", managerName: "Ravi Kumar" },
  { fullName: "Jose Henderson", designation: "Director", departmentName: "Human Resources", gender: "Male", joiningDate: "2015-04-17", managerName: "Ravi Kumar" },
  { fullName: "Isabella Xi", designation: "Vice President", departmentName: "Marketing", gender: "Female", joiningDate: "2013-03-13", managerName: "Ravi Kumar" },
  { fullName: "Easton Bailey", designation: "Manager", departmentName: "Accounting", gender: "Male", joiningDate: "2019-01-25", managerName: "Ravi Kumar" },
  { fullName: "Ruby Barnes", designation: "Manager", departmentName: "IT", gender: "Female", joiningDate: "2020-07-01", managerName: "David Barnes" },
  { fullName: "Elias Alvarado", designation: "Sr. Manager", departmentName: "IT", gender: "Male", joiningDate: "2012-01-09", managerName: "David Barnes" },
  { fullName: "Logan Rivera", designation: "Director", departmentName: "IT", gender: "Male", joiningDate: "2002-05-24", managerName: "David Barnes" },
  { fullName: "Everleigh Ng", designation: "Sr. Manager", departmentName: "Finance", gender: "Female", joiningDate: "2021-06-10", managerName: "Bella Powell" },
  { fullName: "Luna Sanders", designation: "Director", departmentName: "Finance", gender: "Female", joiningDate: "2006-10-26", managerName: "Bella Powell" },
  { fullName: "Mateo Her", designation: "Vice President", departmentName: "Sales", gender: "Male", joiningDate: "2014-03-02", managerName: "Adam Dang" },
  { fullName: "Eva Rivera", designation: "Director", departmentName: "Sales", gender: "Female", joiningDate: "2021-04-02", managerName: "Adam Dang" },
  { fullName: "Savannah Ali", designation: "Sr. Manager", departmentName: "Human Resources", gender: "Female", joiningDate: "2009-02-11", managerName: "Jose Henderson" },
  { fullName: "Eli Jones", designation: "Manager", departmentName: "Human Resources", gender: "Male", joiningDate: "1999-03-14", managerName: "Jose Henderson" },
  { fullName: "Camila Silva", designation: "Sr. Manager", departmentName: "Marketing", gender: "Female", joiningDate: "2003-12-01", managerName: "Isabella Xi" },
  { fullName: "Camila Rogers", designation: "Controls Engineer", departmentName: "Engineering", gender: "Female", joiningDate: "2021-10-21", managerName: "Wyatt Chin" },
  { fullName: "Abigail Mejia", designation: "Quality Engineer", departmentName: "Engineering", gender: "Female", joiningDate: "2005-02-05", managerName: "Wyatt Chin" },
  { fullName: "Theodore Dinh", designation: "Technical Architect", departmentName: "IT", gender: "Male", joiningDate: "1997-11-29", managerName: "Ruby Barnes" },
  { fullName: "Penelope Jordan", designation: "Computer Systems Manager", departmentName: "IT", gender: "Female", joiningDate: "2019-09-27", managerName: "Ruby Barnes" },
  { fullName: "Austin Vo", designation: "Sr. Analyst", departmentName: "Finance", gender: "Male", joiningDate: "1995-11-20", managerName: "Everleigh Ng" },
  { fullName: "Madeline Walker", designation: "Sr. Analyst", departmentName: "Finance", gender: "Female", joiningDate: "2018-06-13", managerName: "Everleigh Ng" },
  { fullName: "Leonardo Dixon", designation: "Analyst", departmentName: "Sales", gender: "Male", joiningDate: "2019-09-05", managerName: "Mateo Her" },
  { fullName: "Joshua Gupta", designation: "Account Representative", departmentName: "Sales", gender: "Male", joiningDate: "2017-01-24", managerName: "Mateo Her" },
];

// BrightPath org chart:
// Meera Patel (Admin)
// ├── Dylan Choi (VP IT) → Eva Coleman → Gabriel Holmes, Nora Brown
// │                      → Peyton Huang → Ezekiel Kumar, Wyatt Rojas
// │                      → John Moore → Riley Padilla, Leah Pena
// ├── Jackson Perry (VP Mktg) → Sadie Washington → Kennedy Foster, Leilani Butler, John Contreras
// ├── Carson Lu (Eng Mgr) → Lucy Alexander → Adeline Huang, Dominic Clark
// ├── Dominic Guzman (Fin) → Caroline Jenkins
// ├── Angel Powell (Sales) → Mateo Vu, William Vu
// └── Everleigh Washington (HR)
const TEST_ORG_2_EMPLOYEES: CsvEmployee[] = [
  { fullName: "Dylan Choi", designation: "Vice President", departmentName: "IT", gender: "Male", joiningDate: "2012-05-11", managerName: "Meera Patel" },
  { fullName: "Jackson Perry", designation: "Vice President", departmentName: "Marketing", gender: "Male", joiningDate: "2019-10-20", managerName: "Meera Patel" },
  { fullName: "Carson Lu", designation: "Engineering Manager", departmentName: "Engineering", gender: "Male", joiningDate: "1996-12-04", managerName: "Meera Patel" },
  { fullName: "Dominic Guzman", designation: "Analyst", departmentName: "Finance", gender: "Male", joiningDate: "2004-05-16", managerName: "Meera Patel" },
  { fullName: "Angel Powell", designation: "Analyst II", departmentName: "Sales", gender: "Male", joiningDate: "2008-07-11", managerName: "Meera Patel" },
  { fullName: "Everleigh Washington", designation: "HRIS Analyst", departmentName: "Human Resources", gender: "Female", joiningDate: "2001-10-20", managerName: "Meera Patel" },
  { fullName: "Eva Coleman", designation: "Director", departmentName: "IT", gender: "Female", joiningDate: "2009-09-20", managerName: "Dylan Choi" },
  { fullName: "Peyton Huang", designation: "Sr. Manager", departmentName: "IT", gender: "Female", joiningDate: "2021-07-02", managerName: "Dylan Choi" },
  { fullName: "John Moore", designation: "Vice President", departmentName: "IT", gender: "Male", joiningDate: "2005-11-08", managerName: "Dylan Choi" },
  { fullName: "Sadie Washington", designation: "Sr. Manager", departmentName: "Marketing", gender: "Female", joiningDate: "2019-05-24", managerName: "Jackson Perry" },
  { fullName: "Lucy Alexander", designation: "Director", departmentName: "Engineering", gender: "Female", joiningDate: "2014-10-29", managerName: "Carson Lu" },
  { fullName: "Caroline Jenkins", designation: "Analyst", departmentName: "Finance", gender: "Female", joiningDate: "2018-05-06", managerName: "Dominic Guzman" },
  { fullName: "Mateo Vu", designation: "Account Representative", departmentName: "Sales", gender: "Male", joiningDate: "2016-09-29", managerName: "Angel Powell" },
  { fullName: "William Vu", designation: "Account Representative", departmentName: "Sales", gender: "Male", joiningDate: "2013-11-14", managerName: "Angel Powell" },
  { fullName: "Gabriel Holmes", designation: "Enterprise Architect", departmentName: "IT", gender: "Male", joiningDate: "2010-11-04", managerName: "Eva Coleman" },
  { fullName: "Nora Brown", designation: "Enterprise Architect", departmentName: "IT", gender: "Female", joiningDate: "2014-02-11", managerName: "Eva Coleman" },
  { fullName: "Ezekiel Kumar", designation: "IT Coordinator", departmentName: "IT", gender: "Male", joiningDate: "2017-06-25", managerName: "Peyton Huang" },
  { fullName: "Wyatt Rojas", designation: "Computer Systems Manager", departmentName: "IT", gender: "Male", joiningDate: "2013-03-20", managerName: "Peyton Huang" },
  { fullName: "Riley Padilla", designation: "Technical Architect", departmentName: "IT", gender: "Female", joiningDate: "2013-05-15", managerName: "John Moore" },
  { fullName: "Leah Pena", designation: "Enterprise Architect", departmentName: "IT", gender: "Female", joiningDate: "1994-01-03", managerName: "John Moore" },
  { fullName: "Kennedy Foster", designation: "Manager", departmentName: "Marketing", gender: "Female", joiningDate: "2013-11-23", managerName: "Sadie Washington" },
  { fullName: "Leilani Butler", designation: "Analyst II", departmentName: "Marketing", gender: "Female", joiningDate: "2021-09-21", managerName: "Sadie Washington" },
  { fullName: "John Contreras", designation: "Analyst II", departmentName: "Marketing", gender: "Male", joiningDate: "2011-05-15", managerName: "Sadie Washington" },
  { fullName: "Adeline Huang", designation: "Controls Engineer", departmentName: "Engineering", gender: "Female", joiningDate: "2019-12-16", managerName: "Lucy Alexander" },
  { fullName: "Dominic Clark", designation: "Quality Engineer", departmentName: "Engineering", gender: "Male", joiningDate: "2012-10-17", managerName: "Lucy Alexander" },
];

// Creates a User account (Better Auth sign-up) + org Member record + links the
// Employee, for every employee in the org that doesn't yet have portal access.
const grantPortalAccess = async (organizationId: string, password: string) => {
  const employees = await prisma.employee.findMany({
    where: { organizationId, userId: null },
    select: { id: true, fullName: true, email: true, role: true },
  });

  let granted = 0;
  for (const emp of employees) {
    try {
      const signUp = await auth.api.signUpEmail({
        body: { email: emp.email, password, name: emp.fullName },
        returnHeaders: true,
      });
      const userId = signUp.response?.user?.id;
      if (!userId) continue;

      await prisma.employee.update({ where: { id: emp.id }, data: { userId } });

      const orgRole = emp.role === "ADMIN" ? "admin" : "employee";
      const existing = await prisma.member.findFirst({ where: { userId, organizationId } });
      if (!existing) {
        await prisma.member.create({
          data: { id: randomUUID(), organizationId, userId, role: orgRole, createdAt: new Date() },
        });
      }

      await prisma.session.updateMany({ where: { userId }, data: { activeOrganizationId: organizationId } });
      granted++;
    } catch (err) {
      console.warn(`Seed: portal access skipped for ${emp.email}:`, err instanceof Error ? err.message : err);
    }
  }
  return granted;
};

const seedTestOrg = async (config: {
  companyName: string;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
  emailDomain: string;
  employees: CsvEmployee[];
}) => {
  const existingAdmin = await prisma.user.findUnique({ where: { email: config.adminEmail } });
  const existingAdminEmployee = existingAdmin
    ? await prisma.employee.findFirst({ where: { userId: existingAdmin.id } })
    : null;

  const organizationId = existingAdminEmployee
    ? existingAdminEmployee.organizationId
    : (await registerCompany({
        companyName: config.companyName,
        fullName: config.adminName,
        email: config.adminEmail,
        password: config.adminPassword,
      }).then((r) => r.organization.id));

  await ensureDefaultDepartments(organizationId);
  for (const name of EXTRA_CSV_DEPARTMENTS) {
    await prisma.department.upsert({
      where: { organizationId_name: { organizationId, name } },
      create: { organizationId, name },
      update: {},
    });
  }
  await ensureDefaultExpenseTypes(organizationId);
  await ensureFloaterLeaveType(organizationId);
  await grantAnnualForOrg(organizationId, new Date().getFullYear());
  await prisma.attendanceSettings.upsert({
    where: { organizationId },
    create: { organizationId },
    update: {},
  });

  await prisma.employee.updateMany({
    where: { organizationId, email: config.adminEmail },
    data: { isActive: true },
  });

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

  const existingEmails = new Set(
    (await prisma.employee.findMany({ where: { organizationId }, select: { email: true } })).map((e) => e.email),
  );

  let created = 0;
  for (const emp of config.employees) {
    const email = toEmail(emp.fullName, config.emailDomain);
    if (existingEmails.has(email)) continue;
    const managerId = emp.managerName ? nameToId.get(emp.managerName) : undefined;
    const employee = await prisma.employee.create({
      data: {
        organizationId,
        fullName: emp.fullName,
        email,
        role: "EMPLOYEE",
        designation: emp.designation,
        departmentId: departmentIdByName.get(emp.departmentName),
        managerId,
        joiningDate: new Date(`${emp.joiningDate}T00:00:00.000Z`),
        gender: emp.gender,
        isActive: true,
      },
    });
    nameToId.set(emp.fullName, employee.id);
    created++;
  }

  const granted = await grantPortalAccess(organizationId, config.adminPassword);

  const total = await prisma.employee.count({ where: { organizationId } });
  console.log(
    `Seed: test org "${config.companyName}" ready (organizationId=${organizationId}), admin ${config.adminEmail} / password "${config.adminPassword}", ${total} employees total (${created} newly created, ${granted} granted portal access).`,
  );
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

  // registerCompany already seeds the default department set (and, for a
  // brand new org, the floater leave type + its first grant) — calling these
  // again here is a no-op upsert / idempotent grant, so this also covers the
  // "org already existed from a previous seed run, before floater leave
  // existed" path.
  await ensureDefaultDepartments(organizationId);
  await ensureDefaultExpenseTypes(organizationId);
  await ensureFloaterLeaveType(organizationId);
  await prisma.attendanceSettings.upsert({
    where: { organizationId },
    create: { organizationId },
    update: {},
  });

  // Best-effort: seeding shouldn't fail in an offline/CI environment just
  // because the currency API is unreachable — the daily scheduler (or a
  // manual /admin/currency/refresh) will populate the cache once it is.
  try {
    await refreshRates(prisma);
  } catch (err) {
    console.warn("Seed: exchange-rate refresh skipped (Frankfurter unreachable?):", err);
  }

  for (const { date, name } of DEMO_OPTIONAL_HOLIDAYS) {
    const holidayDate = new Date(`${date}T00:00:00.000Z`);
    await prisma.holiday.upsert({
      where: { organizationId_date: { organizationId, date: holidayDate } },
      create: { organizationId, date: holidayDate, name, year: toHolidayYear(holidayDate), isOptional: true },
      update: { name, isOptional: true },
    });
  }

  await grantAnnualForOrg(organizationId, new Date().getFullYear());

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

  // Two additional test organizations with 25 employees each from CSV sample data
  await seedTestOrg({
    companyName: "NovaTech Solutions",
    adminName: "Ravi Kumar",
    adminEmail: "admin@novatech.demo.local",
    adminPassword: "DemoPassword123!",
    emailDomain: "novatech.demo.local",
    employees: TEST_ORG_1_EMPLOYEES,
  });

  await seedTestOrg({
    companyName: "BrightPath Industries",
    adminName: "Meera Patel",
    adminEmail: "admin@brightpath.demo.local",
    adminPassword: "DemoPassword123!",
    emailDomain: "brightpath.demo.local",
    employees: TEST_ORG_2_EMPLOYEES,
  });
};

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
