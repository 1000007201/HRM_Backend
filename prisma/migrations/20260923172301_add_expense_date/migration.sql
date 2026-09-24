-- AlterTable
-- Backfills the two existing dev rows with their createdAt day (the only
-- sensible guess for when the expense was incurred), then drops the default
-- so every new row must state its own date.
ALTER TABLE "ExpenseRequest" ADD COLUMN "expenseDate" DATE NOT NULL DEFAULT CURRENT_DATE;
UPDATE "ExpenseRequest" SET "expenseDate" = "createdAt"::date;
ALTER TABLE "ExpenseRequest" ALTER COLUMN "expenseDate" DROP DEFAULT;
