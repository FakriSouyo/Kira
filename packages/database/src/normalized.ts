import { randomUUID } from 'node:crypto';
import type { Orm } from './client';
import { dailyNormalized, financialsNormalized } from './schema';
import { eq } from 'drizzle-orm';

/** Helper normalized tables (Phase 9A) — read/write real, idempotent. */
export class NormalizedStore {
  constructor(private readonly db: Orm) {}

  async upsertFinancials(params: { ticker: string; year: number; revenue?: number | null; earnings?: number | null; roe?: number | null; netMargin?: number | null }): Promise<void> {
    await this.db
      .insert(financialsNormalized)
      .values({
        id: randomUUID(),
        ticker: params.ticker,
        year: params.year,
        revenue: params.revenue ?? null,
        earnings: params.earnings ?? null,
        roe: params.roe ?? null,
        netMargin: params.netMargin ?? null,
      })
      .onConflictDoUpdate({
        target: [financialsNormalized.ticker, financialsNormalized.year] as never,
        set: {
          revenue: params.revenue ?? null,
          earnings: params.earnings ?? null,
          roe: params.roe ?? null,
          netMargin: params.netMargin ?? null,
        },
      });
  }

  async upsertDaily(params: { ticker: string; date: string; closePrice?: number | null; volume?: number | null }): Promise<void> {
    await this.db
      .insert(dailyNormalized)
      .values({
        id: randomUUID(),
        ticker: params.ticker,
        date: params.date,
        closePrice: params.closePrice ?? null,
        volume: params.volume ?? null,
      })
      .onConflictDoUpdate({
        target: [dailyNormalized.ticker, dailyNormalized.date] as never,
        set: {
          closePrice: params.closePrice ?? null,
          volume: params.volume ?? null,
        },
      });
  }

  async listFinancials(ticker: string): Promise<typeof financialsNormalized.$inferSelect[]> {
    return (await this.db.select().from(financialsNormalized).where(eq(financialsNormalized.ticker, ticker))) as typeof financialsNormalized.$inferSelect[];
  }

  async listDaily(ticker: string): Promise<typeof dailyNormalized.$inferSelect[]> {
    return (await this.db.select().from(dailyNormalized).where(eq(dailyNormalized.ticker, ticker))) as typeof dailyNormalized.$inferSelect[];
  }
}
