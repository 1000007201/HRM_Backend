import type { LopBasis, PrismaClient } from "../../generated/prisma/client.js";

export interface UpdatePayrollSettingsParams {
  organizationId: string;
  pfEnabled?: boolean;
  pfCeiling?: boolean;
  esiEnabled?: boolean;
  ptEnabled?: boolean;
  ptState?: string | null;
  lopBasis?: LopBasis;
}

// Created lazily on first read/write via upsert rather than seeded at
// registration — an org that never opens payroll settings never gets a row.
export const getOrCreatePayrollSettings = (prisma: PrismaClient, params: { organizationId: string }) =>
  prisma.payrollSettings.upsert({
    where: { organizationId: params.organizationId },
    create: { organizationId: params.organizationId },
    update: {},
  });

export const updatePayrollSettings = (prisma: PrismaClient, params: UpdatePayrollSettingsParams) => {
  const { organizationId, ...data } = params;
  return prisma.payrollSettings.upsert({
    where: { organizationId },
    create: { organizationId, ...data },
    update: data,
  });
};
