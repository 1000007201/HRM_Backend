-- AlterTable
ALTER TABLE "LeaveType" ADD COLUMN     "isFloaterHolidayType" BOOLEAN NOT NULL DEFAULT false;

-- At most one floater-linked leave type per org. Prisma's @@unique can't
-- express a WHERE clause, so this is hand-written, same technique as
-- RegularizationRequest_one_pending_per_employee_date.
CREATE UNIQUE INDEX "LeaveType_one_floater_holiday_type_per_org"
  ON "LeaveType"("organizationId") WHERE "isFloaterHolidayType" = true;
