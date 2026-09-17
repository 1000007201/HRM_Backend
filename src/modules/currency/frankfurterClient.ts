import { env } from "../../env.js";
import { CONVERTIBLE_CURRENCY_CODES, type CurrencyCode } from "./currencies.js";

// One row of Frankfurter's response per requested symbol: INR per 1 unit of
// `currency` is 1 / (the INR->currency rate Frankfurter returns), since we
// query base=INR to fetch every supported currency's rate in a single call.
export interface FetchedRate {
  currency: Exclude<CurrencyCode, "INR">;
  inrPerUnit: number;
}

export interface CurrencyRateProvider {
  fetchInrRates(): Promise<{ rateDate: Date; rates: FetchedRate[] }>;
}

interface FrankfurterLatestResponse {
  amount: number;
  base: string;
  date: string;
  rates: Record<string, number>;
}

// Isolated behind CurrencyRateProvider the same way sendEmail isolates Resend
// (src/core/email.ts) — swapping the rate source (a different provider, a
// self-hosted ECB mirror) is a new implementation of this interface, not a
// rewrite of exchangeRates.service.ts.
class FrankfurterClient implements CurrencyRateProvider {
  async fetchInrRates(): Promise<{ rateDate: Date; rates: FetchedRate[] }> {
    const symbols = CONVERTIBLE_CURRENCY_CODES.join(",");
    const url = `${env.FRANKFURTER_API_URL}/latest?base=INR&symbols=${symbols}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Frankfurter API request failed with status ${response.status}`);
    }
    const body = (await response.json()) as FrankfurterLatestResponse;

    // Frankfurter returns "1 INR = <value> <currency>" — invert to get INR
    // per 1 unit of currency, which is what ExchangeRate.inrPerUnit stores.
    const rates = CONVERTIBLE_CURRENCY_CODES.flatMap((currency): FetchedRate[] => {
      const inrToCurrency = body.rates[currency];
      if (!inrToCurrency || inrToCurrency <= 0) {
        return [];
      }
      return [{ currency, inrPerUnit: 1 / inrToCurrency }];
    });

    return { rateDate: new Date(`${body.date}T00:00:00.000Z`), rates };
  }
}

export const currencyRateProvider: CurrencyRateProvider = new FrankfurterClient();
