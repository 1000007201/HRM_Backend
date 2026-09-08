-- Data migration FIRST: remap roles that the shrunk enum will no longer
-- have, so the type swap below never hits a value it can't cast.
-- HR folds into ADMIN (HR-only actions are now ADMIN-only); MANAGER folds
-- into EMPLOYEE (manager approval powers are gone, reporting lines via
-- Employee.managerId are unaffected).
UPDATE "Employee" SET "role" = 'ADMIN' WHERE "role" = 'HR';
UPDATE "Employee" SET "role" = 'EMPLOYEE' WHERE "role" = 'MANAGER';

-- AlterEnum
BEGIN;
CREATE TYPE "EmployeeRole_new" AS ENUM ('ADMIN', 'EMPLOYEE');
ALTER TABLE "public"."Employee" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "Employee" ALTER COLUMN "role" TYPE "EmployeeRole_new" USING ("role"::text::"EmployeeRole_new");
ALTER TYPE "EmployeeRole" RENAME TO "EmployeeRole_old";
ALTER TYPE "EmployeeRole_new" RENAME TO "EmployeeRole";
DROP TYPE "public"."EmployeeRole_old";
ALTER TABLE "Employee" ALTER COLUMN "role" SET DEFAULT 'EMPLOYEE';
COMMIT;
