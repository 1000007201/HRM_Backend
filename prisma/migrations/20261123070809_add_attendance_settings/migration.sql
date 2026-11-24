-- CreateTable
CREATE TABLE "AttendanceSettings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fullDayMinutes" INTEGER NOT NULL DEFAULT 480,
    "halfDayMinutes" INTEGER NOT NULL DEFAULT 240,
    "weekOffDays" INTEGER[] DEFAULT ARRAY[0, 6]::INTEGER[],
    "allowRegularization" BOOLEAN NOT NULL DEFAULT true,
    "maxRegularizationsPerMonth" INTEGER,
    "regularizationWindowDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceSettings_organizationId_key" ON "AttendanceSettings"("organizationId");

-- AddForeignKey
ALTER TABLE "AttendanceSettings" ADD CONSTRAINT "AttendanceSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing org gets a default AttendanceSettings row.
INSERT INTO "AttendanceSettings" ("id", "organizationId", "fullDayMinutes", "halfDayMinutes", "weekOffDays", "allowRegularization", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    "id",
    480,
    240,
    ARRAY[0, 6]::INTEGER[],
    true,
    NOW(),
    NOW()
FROM "organization"
WHERE "id" NOT IN (SELECT "organizationId" FROM "AttendanceSettings");
