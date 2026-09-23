import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { env, isProduction } from "./env.js";
import authPlugin from "./core/plugins/auth.js";
import authGuardPlugin from "./core/plugins/authGuard.js";
import { registerErrorHandler } from "./core/plugins/errorHandler.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { registerCompanyRoutes } from "./modules/identity/registerCompany.routes.js";
import { invitationRoutes } from "./modules/identity/invitations.routes.js";
import { employeeRoutes } from "./modules/employees/employees.routes.js";
import { employeeDocumentRoutes, MAX_DOCUMENT_SIZE_BYTES } from "./modules/employees/employeeDocuments.routes.js";
import { departmentRoutes } from "./modules/departments/departments.routes.js";
import { leaveRoutes } from "./modules/leave/leave.routes.js";
import { leaveRequestRoutes } from "./modules/leave/leaveRequests.routes.js";
import { systemAccrualRoutes } from "./modules/leave/systemAccrual.routes.js";
import { holidayRoutes } from "./modules/holidays/holidays.routes.js";
import { attendanceRoutes } from "./modules/attendance/attendance.routes.js";
import { regularizationRoutes } from "./modules/attendance/regularizations.routes.js";
import { expenseTypeRoutes } from "./modules/expenses/expenseTypes.routes.js";
import { expenseRequestRoutes } from "./modules/expenses/expenseRequests.routes.js";
import { expenseAttachmentRoutes } from "./modules/expenses/expenseAttachments.routes.js";
import { currencyRoutes } from "./modules/currency/currency.routes.js";
import { systemCurrencyRoutes } from "./modules/currency/systemCurrency.routes.js";
import { salaryComponentRoutes } from "./modules/salary/salaryComponents.routes.js";
import { salaryStructureRoutes } from "./modules/salary/salaryStructures.routes.js";
import { payrollSettingsRoutes } from "./modules/payroll/payrollSettings.routes.js";
import { payrollRunRoutes } from "./modules/payroll/payrollRuns.routes.js";
import { payslipRoutes } from "./modules/payroll/payslips.routes.js";
import { taxDeclarationRoutes } from "./modules/payroll/taxDeclaration.routes.js";

export const buildApp = (): FastifyInstance => {
  const app = Fastify({
    logger: isProduction
      ? true
      : {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
          },
        },
  });

  app.register(cors, {
    origin: env.FRONTEND_ORIGIN,
    credentials: true,
    // @fastify/cors's own default is 'GET,HEAD,POST' (see its index.js) —
    // every PUT/PATCH/DELETE route in this API (salary components, employee
    // updates, payroll settings, ...) was silently unreachable from a real
    // browser without this: the preflight would advertise only GET/HEAD/POST,
    // so the browser blocks the actual request before it's ever sent.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
  });
  // ^ @fastify/cors accepts an array of exact-match origins natively —
  // reflects whichever one matches the request's Origin header.
  app.register(multipart, { limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES, files: 1 } });

  app.register(authPlugin);
  app.register(authGuardPlugin);
  registerErrorHandler(app);

  // Grouped by module — mirrors src/modules/*.
  app.register(healthRoutes);
  app.register(registerCompanyRoutes);
  app.register(invitationRoutes);
  app.register(employeeRoutes);
  app.register(employeeDocumentRoutes);
  app.register(departmentRoutes);
  app.register(leaveRoutes);
  app.register(leaveRequestRoutes);
  app.register(systemAccrualRoutes);
  app.register(holidayRoutes);
  app.register(attendanceRoutes);
  app.register(regularizationRoutes);
  app.register(expenseTypeRoutes);
  app.register(expenseRequestRoutes);
  app.register(expenseAttachmentRoutes);
  app.register(currencyRoutes);
  app.register(systemCurrencyRoutes);
  app.register(salaryComponentRoutes);
  app.register(salaryStructureRoutes);
  app.register(payrollSettingsRoutes);
  app.register(payrollRunRoutes);
  app.register(payslipRoutes);
  app.register(taxDeclarationRoutes);

  return app;
};
