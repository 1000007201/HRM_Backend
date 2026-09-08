import { prisma } from "../../core/prisma.js";

// A reasonable Indian SME default set. `name` is the per-org unique key
// (Department.organizationId_name) — ensureDefaultDepartments upserts on it,
// so re-running (or calling it for an org that already has these) never
// duplicates or overwrites an admin's later edits (rename, deactivate).
const DEFAULT_DEPARTMENTS = [
  "Engineering",
  "Sales",
  "Marketing",
  "Human Resources",
  "Finance & Accounts",
  "Operations",
  "Customer Support",
  "Administration",
] as const;

// Called once at company registration so every new org starts with the
// default set. Safe to call again for an existing org — upsert's
// `update: {}` is a no-op when the row already exists.
export const ensureDefaultDepartments = async (organizationId: string): Promise<void> => {
  await Promise.all(
    DEFAULT_DEPARTMENTS.map((name) =>
      prisma.department.upsert({
        where: { organizationId_name: { organizationId, name } },
        create: { organizationId, name },
        update: {},
      }),
    ),
  );
};
