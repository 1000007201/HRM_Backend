import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.url("BETTER_AUTH_URL must be a valid URL"),
  // Comma-separated list of origins allowed to call this API with
  // credentials — e.g. the same machine's localhost AND its LAN IP, so the
  // frontend works both from the dev machine and from other devices on the
  // network at the same time.
  FRONTEND_ORIGIN: z
    .string()
    .min(1, "FRONTEND_ORIGIN is required")
    .transform((value) => value.split(",").map((origin) => origin.trim()))
    .pipe(z.array(z.url("Each FRONTEND_ORIGIN entry must be a valid URL")).min(1)),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.email("EMAIL_FROM must be a valid email address").default("onboarding@resend.dev"),
  REQUIRE_EMAIL_VERIFICATION: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  ENABLE_PUBLIC_SIGNUP: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  REGISTRATION_SECRET: z.string().min(16).optional(),
  ACCRUAL_SECRET: z
    .string()
    .min(16, "ACCRUAL_SECRET must be at least 16 characters"),
  // Worked minutes below this on a day with attendance => HALF_DAY instead of
  // PRESENT. 240 (4h) is the usual Indian SME split of an 8h day.
  ATTENDANCE_HALF_DAY_THRESHOLD_MINUTES: z.coerce.number().int().positive().default(240),
  // Base URL of the Frankfurter currency API (ECB rates, no key required).
  // Overridable so a provider swap or self-hosted mirror is a config change,
  // not a code change — see src/modules/currency/frankfurterClient.ts.
  FRANKFURTER_API_URL: z.url("FRANKFURTER_API_URL must be a valid URL").default("https://api.frankfurter.dev/v1"),
  // Shared secret gating POST /system/currency/refresh (sent as the
  // X-Currency-Refresh-Secret header). Only the daily cron should know this value.
  CURRENCY_REFRESH_SECRET: z
    .string()
    .min(16, "CURRENCY_REFRESH_SECRET must be at least 16 characters"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
