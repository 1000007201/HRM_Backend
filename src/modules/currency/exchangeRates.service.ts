import { Prisma, type PrismaClient, type ExchangeRate } from "../../generated/prisma/client.js";
import { AppError } from "../../core/errors.js";
import { isSameUtcCalendarDay } from "../../shared/workingDays.js";
import { currencyRateProvider } from "./frankfurterClient.js";
import type { CurrencyCode } from "./currencies.js";

// The daily job: one Frankfurter call fetches every supported currency's
// rate at once (base=INR, all symbols), so refreshing is always a single
// request regardless of how many currencies are supported.
export const refreshRates = async (prisma: PrismaClient): Promise<ExchangeRate[]> => {
  const { rateDate, rates } = await currencyRateProvider.fetchInrRates();

  return Promise.all(
    rates.map(({ currency, inrPerUnit }) => {
      const inrPerUnitDecimal = new Prisma.Decimal(inrPerUnit).toDecimalPlaces(6);
      return prisma.exchangeRate.upsert({
        where: { currency_rateDate: { currency, rateDate } },
        create: { currency, rateDate, inrPerUnit: inrPerUnitDecimal },
        update: { inrPerUnit: inrPerUnitDecimal, fetchedAt: new Date() },
      });
    }),
  );
};

export interface InrRate {
  inrPerUnit: Prisma.Decimal;
  rateDate: Date;
}

const INR_RATE: InrRate = { inrPerUnit: new Prisma.Decimal(1), rateDate: new Date() };

// Cache-first: the daily scheduler (see currencyScheduler.ts) keeps today's
// rate in the cache under normal operation, so this almost always just reads
// it back with no outbound call. The on-demand refresh below only fires when
// that hasn't happened yet (a missed cron tick, a fresh cache) — never on
// every conversion.
export const getInrRate = async (prisma: PrismaClient, currency: CurrencyCode): Promise<InrRate> => {
  if (currency === "INR") {
    return INR_RATE;
  }

  const cached = await prisma.exchangeRate.findFirst({ where: { currency }, orderBy: { rateDate: "desc" } });
  if (cached && isSameUtcCalendarDay(cached.rateDate, new Date())) {
    return cached;
  }

  try {
    const refreshed = await refreshRates(prisma);
    const updated = refreshed.find((rate) => rate.currency === currency);
    if (updated) {
      return updated;
    }
    // Provider responded but didn't include this currency — fall through to
    // whatever was cached rather than treating it as a hard failure.
  } catch (err) {
    console.error(`[currency] refresh failed while fetching rate for ${currency}:`, err);
  }

  if (cached) {
    return cached;
  }

  throw new AppError(
    503,
    "INTERNAL",
    `No exchange rate is available for ${currency} and the rate provider could not be reached`,
  );
};

export interface ConversionResult {
  amountInInr: Prisma.Decimal;
  inrPerUnit: Prisma.Decimal;
  rateDate: Date;
}

// Freezes an amount to INR at whatever rate is current right now — the
// caller (the upcoming ExpenseRequest) stores the result, so a later rate
// change never retroactively changes an already-submitted expense.
export const convertToInr = async (
  prisma: PrismaClient,
  amount: Prisma.Decimal | number | string,
  currency: CurrencyCode,
): Promise<ConversionResult> => {
  const { inrPerUnit, rateDate } = await getInrRate(prisma, currency);
  const amountInInr = new Prisma.Decimal(amount).times(inrPerUnit).toDecimalPlaces(2);
  return { amountInInr, inrPerUnit, rateDate };
};
