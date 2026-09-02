/**
 * Kontrak data Sectors API (addendum §22/Task 6).
 * Nama endpoint terpusat di client.ts — bila kontrak API berubah,
 * hanya file itu yang perlu disentuh (mock mengikuti tipe yang sama).
 */

/** Company Report — snapshot fundamental & valuasi (rubrik Judge: health, valuation). */
export interface CompanyReport {
  ticker: string;
  name?: string;
  sector?: string;
  /** Tanggal acuan data (ISO). */
  asOf?: string;
  financials: {
    /** Return on equity, %. */
    roe?: number;
    /** Return on assets, %. */
    roa?: number;
    /** Net margin, %. */
    netMargin?: number;
    /** Gross margin, % (tidak selalu ada untuk bank). */
    grossMargin?: number;
    /** Debt-to-equity, rasio. */
    debtToEquity?: number;
    /** Current ratio, rasio. */
    currentRatio?: number;
  };
  valuation: {
    price?: number;
    /** Price-to-earnings. */
    pe?: number;
    /** Price-to-book. */
    pb?: number;
    /** Dividend yield, %. */
    dividendYield?: number;
  };
}

/** Quarterly Financials — tren pertumbuhan (rubrik Judge: growth). */
export interface QuarterlyFinancials {
  ticker: string;
  currency?: string;
  /** Terurut terbaru pertama. */
  quarters: Array<{
    /** Mis. "2024-Q4". */
    period: string;
    revenue: number;
    netIncome: number;
    /** Pertumbuhan pendapatan YoY, %. */
    revenueGrowthYoy?: number;
    /** Pertumbuhan laba bersih YoY, %. */
    netIncomeGrowthYoy?: number;
  }>;
}

/** Satu baris hasil screener (sebelum skor match dihitung client-side). */
export interface ScreenerRow {
  ticker: string;
  name?: string;
  roe?: number;
  revenueGrowthYoy?: number;
  netIncomeGrowthYoy?: number;
  pe?: number;
  pb?: number;
}

/** Hasil screener dengan skor match deterministik (0-100). */
export type ScreenerResult = ScreenerRow & { matchScore: number };

/** Interface murni — consumed oleh workflow; implementasi: SectorsClient / MockSectorsApi. */
export interface SectorsApi {
  getCompanyReport(ticker: string): Promise<CompanyReport>;
  getQuarterlyFinancials(ticker: string): Promise<QuarterlyFinancials>;
  screen(criteria: string[]): Promise<ScreenerResult[]>;
}

/** Nama source evidence — dipakai EvidenceStore untuk provenance (addendum §07). */
export const SECTORS_SOURCES = {
  companyReport: 'sectors.company_report',
  quarterlyFinancials: 'sectors.quarterly_financials',
} as const;
