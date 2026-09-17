-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('PENDING_MANAGER', 'PENDING_ADMIN', 'APPROVED', 'PAYMENT_INITIATED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ExpenseRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "approverManagerId" TEXT NOT NULL,
    "expenseTypeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "exchangeRate" DECIMAL(12,6) NOT NULL,
    "amountInInr" DECIMAL(12,2) NOT NULL,
    "rateDate" DATE NOT NULL,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'PENDING_MANAGER',
    "managerDecidedAt" TIMESTAMP(3),
    "managerDecisionNote" TEXT,
    "adminDecidedById" TEXT,
    "adminDecidedAt" TIMESTAMP(3),
    "adminDecisionNote" TEXT,
    "paymentInitiatedById" TEXT,
    "paymentInitiatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpenseRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseAttachment" (
    "id" TEXT NOT NULL,
    "expenseRequestId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExpenseRequest_organizationId_idx" ON "ExpenseRequest"("organizationId");

-- CreateIndex
CREATE INDEX "ExpenseRequest_employeeId_idx" ON "ExpenseRequest"("employeeId");

-- CreateIndex
CREATE INDEX "ExpenseRequest_approverManagerId_idx" ON "ExpenseRequest"("approverManagerId");

-- CreateIndex
CREATE INDEX "ExpenseRequest_status_idx" ON "ExpenseRequest"("status");

-- CreateIndex
CREATE INDEX "ExpenseAttachment_expenseRequestId_idx" ON "ExpenseAttachment"("expenseRequestId");

-- AddForeignKey
ALTER TABLE "ExpenseRequest" ADD CONSTRAINT "ExpenseRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseRequest" ADD CONSTRAINT "ExpenseRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseRequest" ADD CONSTRAINT "ExpenseRequest_approverManagerId_fkey" FOREIGN KEY ("approverManagerId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseRequest" ADD CONSTRAINT "ExpenseRequest_expenseTypeId_fkey" FOREIGN KEY ("expenseTypeId") REFERENCES "ExpenseType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseRequest" ADD CONSTRAINT "ExpenseRequest_adminDecidedById_fkey" FOREIGN KEY ("adminDecidedById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseRequest" ADD CONSTRAINT "ExpenseRequest_paymentInitiatedById_fkey" FOREIGN KEY ("paymentInitiatedById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseAttachment" ADD CONSTRAINT "ExpenseAttachment_expenseRequestId_fkey" FOREIGN KEY ("expenseRequestId") REFERENCES "ExpenseRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseAttachment" ADD CONSTRAINT "ExpenseAttachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
