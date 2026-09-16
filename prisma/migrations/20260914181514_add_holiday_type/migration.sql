-- CreateEnum
CREATE TYPE "HolidayType" AS ENUM ('FIXED', 'FLOATER');

-- AlterTable
ALTER TABLE "Holiday" ADD COLUMN     "type" "HolidayType" NOT NULL DEFAULT 'FIXED';
