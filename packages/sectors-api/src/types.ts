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
    /** YoY quarterly revenue growth, % (from yoy_quarter_revenue_growth). */
    yoyQuarterRevenueGrowth?: number;
    /** YoY quarterly earnings growth, % (from yoy_quarter_earnings_growth). */
    yoyQuarterEarningsGrowth?: number;
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

// ─────────────────────────────────────────────────────────────────────────────
// Market & News Researcher (addendum §24-A.3–4, Phase 1)
// Kontrak logis → dasar tipe & mock; kontrak HTTP riil diverifikasi di client.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** Daily Transaction — likuiditas & aktivitas perdagangan (addendum §27 "Daily Transaction"). */
export interface DailyTransaction {
  ticker: string;
  /** UTC ISO. */
  asOf: string;
  /** Rentang agregasi, mis. "30d". */
  window: string;
  /** Rata-rata nilai transaksi harian, dalam miliar (IDR). */
  avgValueBillion?: number;
  /** Volume relatif vs rata-rata 3 bulan (>1 = di atas normal), tanpa satuan. */
  volumeRatio?: number;
  /** Persentase hari tutup di atas harga pembukaan dalam window, 0-100. */
  upDaysPct?: number;
  /** Rata-rata pergerakan harga absolut harian, %. */
  avgIntradayVolatilityPct?: number;
  /** NULL bila tidak tersedia — menghindari ramalan kosong. */
  liquidityBand?: 'high' | 'moderate' | 'low';
}

/** Foreign Flow — arah aliran dana asing (addendum §27 "Foreign Flow"). */
export interface ForeignFlow {
  ticker: string;
  asOf: string;
  window: string;
  /** Flow kumulatif asing relatif terhadap kapitalisasi, %. */
  netForeignPctOfCap?: number;
  /** Sinyal bersih: net beli / net jual / netral. */
  netFlow?: 'buy' | 'sell' | 'neutral';
  /** Proporsi jumlah hari net buy asing dalam window, 0-100. */
  netBuyDaysPct?: number;
}

/** Satu artikel/laporan berita (addendum §24-A.4). */
export interface NewsArticle {
  /** ID unik sumber — mendukung dedup content-hash cross-run. */
  id: string;
  ticker: string;
  headline: string;
  /** URL sumber. */
  url?: string;
  /** ISO publikasi. */
  publishedAt: string;
  /** Ringkas — untuk zona [1]; baca lanjutan di evidence `data`. */
  snippet: string;
  /** Klasifikasi sentimen isi berita. */
  sentiment?: 'positive' | 'negative' | 'neutral';
  /** Sumber berita (mis. "Reuters"). */
  source?: string;
}

/** Filing regulator (annual report, disclosure dst.). */
export interface Filing {
  id: string;
  ticker: string;
  /** Jenis filing, mis. "annual_report", "disclosure", "related_party". */
  type: string;
  title: string;
  /** ISO di-filing. */
  filedAt: string;
  url?: string;
}

/** Skor sentimen agregat suatu ticker pada periode tertentu. */
export interface Sentiment {
  ticker: string;
  asOf: string;
  window: string;
  /** Skor agregat -1..1 (negatif = bearish, positif = bullish). */
  aggregate?: number;
  /** Proporsi artikel positif / negatif / netral, masing-masing 0..1. */
  distribution?: { positive: number; negative: number; neutral: number };
  /** Jumlah artikel yang diproses. */
  articleCount?: number;
}

/** Interface murni — consumed oleh workflow; implementasi: SectorsClient / MockSectorsApi. */
export interface SectorsApi {
  getCompanyReport(ticker: string): Promise<CompanyReport>;
  getQuarterlyFinancials(ticker: string): Promise<QuarterlyFinancials>;
  screen(criteria: string[]): Promise<ScreenerResult[]>;

  // —— Market Researcher (Phase 1, §24-A.2) ——
  getDailyTransaction(ticker: string): Promise<DailyTransaction>;
  getForeignFlow(ticker: string): Promise<ForeignFlow>;

  // —— News Researcher (Phase 1, §24-A.2) ——
  getNews(ticker: string): Promise<NewsArticle[]>;
  getFilings(ticker: string): Promise<Filing[]>;
  getSentiment(ticker: string): Promise<Sentiment>;
}

/** Nama source evidence — dipakai EvidenceStore untuk provenance (addendum §07/§24-A). */
export const SECTORS_SOURCES = {
  companyReport: 'sectors.company_report',
  quarterlyFinancials: 'sectors.quarterly_financials',
  dailyTransaction: 'sectors.daily_transaction',
  foreignFlow: 'sectors.foreign_flow',
  news: 'sectors.news',
  filings: 'sectors.filings',
  sentiment: 'sectors.sentiment',
} as const;
