-- Replace the document category list with the fixed set of onboarding
-- documents (Gov. ID, Higher Secondary Marksheet, Graduation, PG, and the
-- previous-company Experience/Relieving letters). ADDRESS_PROOF had no
-- replacement in the new list, so existing rows fall back to GOV_ID rather
-- than being dropped.
ALTER TYPE "EmployeeDocumentType" RENAME TO "EmployeeDocumentType_old";

CREATE TYPE "EmployeeDocumentType" AS ENUM ('GOV_ID', 'HIGHER_SECONDARY_MARKSHEET', 'GRADUATION_CERTIFICATE', 'PG_CERTIFICATE', 'EXPERIENCE_CERTIFICATE', 'RELIEVING_LETTER');

ALTER TABLE "EmployeeDocument" ALTER COLUMN "type" TYPE "EmployeeDocumentType" USING (
  CASE "type"::text
    WHEN 'IDENTITY_PROOF' THEN 'GOV_ID'
    WHEN 'MARKSHEET' THEN 'HIGHER_SECONDARY_MARKSHEET'
    WHEN 'EXPERIENCE_CERTIFICATE' THEN 'EXPERIENCE_CERTIFICATE'
    WHEN 'RELIEVING_LETTER' THEN 'RELIEVING_LETTER'
    WHEN 'ADDRESS_PROOF' THEN 'GOV_ID'
  END
)::"EmployeeDocumentType";

DROP TYPE "EmployeeDocumentType_old";
