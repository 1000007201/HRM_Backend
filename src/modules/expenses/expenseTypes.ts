import { prisma } from "../../core/prisma.js";

// A reasonable default set for an Indian SME expense policy. `name` is the
// per-org unique key (ExpenseType.organizationId_name) — ensureDefaultExpenseTypes
// upserts on it, so re-running (or calling it for an org that already has
// these) never duplicates or overwrites an admin's later edits (rename,
// deactivate).
const DEFAULT_EXPENSE_TYPES = [
  "Travel",
  "Accommodation",
  "Meals",
  "Office Supplies",
  "Software & Subscriptions",
  "Client Entertainment",
  "Training",
  "Other",
] as const;

// Called once at company registration so every new org starts with the
// default set. Safe to call again for an existing org — upsert's
// `update: {}` is a no-op when the row already exists.
export const ensureDefaultExpenseTypes = async (organizationId: string): Promise<void> => {
  await Promise.all(
    DEFAULT_EXPENSE_TYPES.map((name) =>
      prisma.expenseType.upsert({
        where: { organizationId_name: { organizationId, name } },
        create: { organizationId, name },
        update: {},
      }),
    ),
  );
};
