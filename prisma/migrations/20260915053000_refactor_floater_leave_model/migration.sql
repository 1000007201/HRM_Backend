-- Holiday: replace the FIXED/FLOATER enum with a plain isOptional boolean.
ALTER TABLE "Holiday" ADD COLUMN     "isOptional" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Holiday" SET "isOptional" = true WHERE "type" = 'FLOATER';
ALTER TABLE "Holiday" DROP COLUMN "type";
DROP TYPE "HolidayType";

-- LeaveType: add the allocation-type split and the annual-grant amount.
CREATE TYPE "LeaveAllocationType" AS ENUM ('MONTHLY_ACCRUAL', 'ANNUAL_GRANT');
ALTER TABLE "LeaveType" ADD COLUMN     "allocationType" "LeaveAllocationType" NOT NULL DEFAULT 'MONTHLY_ACCRUAL';
ALTER TABLE "LeaveType" ADD COLUMN     "annualGrantDays" DECIMAL(6,2);

-- Rename (not drop+add) to preserve existing values.
ALTER TABLE "LeaveType" RENAME COLUMN "isFloaterHolidayType" TO "isFloater";

-- Drop the partial unique index added for "at most one floater-linked leave
-- type per org" in the previous migration — isFloater deliberately carries no
-- such constraint (a product choice, not this model's job to enforce).
DROP INDEX IF EXISTS "LeaveType_one_floater_holiday_type_per_org";
