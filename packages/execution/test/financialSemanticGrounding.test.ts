import { describe, expect, it } from 'vitest';
import {
  financialNumericAssertions,
  financialStatementIsGrounded,
  resolveFinancialSemanticFigure,
} from '../src/financialSemanticGrounding';

describe('financial semantic grounding', () => {
  it.each([
    ['financials.roe', 'roe', 'percent'],
    ['financials.roa', 'roa', 'percent'],
    ['financials.netMargin', 'netMargin', 'percent'],
    ['financials.grossMargin', 'grossMargin', 'percent'],
    ['financials.debtToEquity', 'debtToEquity', 'ratio'],
    ['financials.currentRatio', 'currentRatio', 'ratio'],
    ['financials.yoyQuarterRevenueGrowth', 'revenueGrowthYoy', 'percent'],
    ['financials.yoyQuarterEarningsGrowth', 'netIncomeGrowthYoy', 'percent'],
    ['valuation.price', 'price', 'nominal'],
    ['valuation.pe', 'pe', 'multiple'],
    ['valuation.pb', 'pb', 'multiple'],
    ['valuation.dividendYield', 'dividendYield', 'percent'],
  ] as const)('maps company-report path %s to %s / %s', (path, metric, unitClass) => {
    const figure = resolveFinancialSemanticFigure({
      kind: 'company_report', path, periodLabel: '2025-12-31',
      data: { financials: { roe: 22.4, roa: 5, netMargin: 10, grossMargin: 30, debtToEquity: 1,
        currentRatio: 1.5, yoyQuarterRevenueGrowth: 8, yoyQuarterEarningsGrowth: 4 },
        valuation: { price: 100, pe: 12, pb: 2, dividendYield: 3 } },
    });
    expect(figure).toMatchObject({ metric, unitClass, periodLabel: '2025-12-31' });
  });

  it.each([
    ['quarters[0].revenue', 'revenue', 'currency'],
    ['quarters[0].netIncome', 'netIncome', 'currency'],
    ['quarters[0].revenueGrowthYoy', 'revenueGrowthYoy', 'percent'],
    ['quarters[0].netIncomeGrowthYoy', 'netIncomeGrowthYoy', 'percent'],
    ['cumulativeYtd.revenueGrowthYoy', 'revenueGrowthYoy', 'percent'],
    ['cumulativeYtd.netIncomeGrowthYoy', 'netIncomeGrowthYoy', 'percent'],
  ] as const)('maps quarterly path %s to %s / %s', (path, metric, unitClass) => {
    const data = {
      currency: 'IDR',
      quarters: [{ period: '2025-Q4', revenue: 100, netIncome: 20, revenueGrowthYoy: 8, netIncomeGrowthYoy: 4 }],
      cumulativeYtd: { periodLabel: '2025 FY vs 2024 FY', revenueGrowthYoy: 7, netIncomeGrowthYoy: 3 },
    };
    const figure = resolveFinancialSemanticFigure({ kind: 'quarterly_financials', path, periodLabel: 'period', data });
    expect(figure).toMatchObject({ metric, unitClass });
    if (unitClass === 'currency') expect(figure?.currencyCode).toBe('IDR');
  });

  it('binds currency and unit assertions to the cited semantic figure', () => {
    const figure = resolveFinancialSemanticFigure({
      kind: 'quarterly_financials', path: 'quarters[0].revenue', periodLabel: '2025-Q4',
      data: { currency: 'IDR', quarters: [{ period: '2025-Q4', revenue: 100 }] },
    })!;
    expect(financialStatementIsGrounded('Revenue was IDR 100.', [figure])).toBe(true);
    expect(financialStatementIsGrounded('Revenue was USD 100.', [figure])).toBe(false);
    expect(financialStatementIsGrounded('Revenue growth was 100%.', [figure])).toBe(false);
  });

  it('fails closed on wrong metrics and units while ignoring period-only digits', () => {
    const figure = resolveFinancialSemanticFigure({
      kind: 'company_report', path: 'financials.roe', periodLabel: '2025-12-31',
      data: { financials: { roe: 22.4 } },
    })!;
    expect(financialStatementIsGrounded('ROE was 22.4%.', [figure])).toBe(true);
    expect(financialStatementIsGrounded('Revenue growth was 22.4%.', [figure])).toBe(false);
    expect(financialStatementIsGrounded('ROE was 22.4x.', [figure])).toBe(false);
    expect(financialNumericAssertions('Q2 2026, H1 2025, 2024-12-31, FY 2025, 2025 FY')).toEqual([]);
  });

  it('fails closed on quantitative number words but allows ordinary prose and period references', () => {
    const roe = resolveFinancialSemanticFigure({
      kind: 'company_report', path: 'financials.roe', periodLabel: '2025-12-31', data: { financials: { roe: 22.4 } },
    })!;
    expect(financialStatementIsGrounded('ROE was twenty-two point four percent.', [roe])).toBe(false);
    expect(financialStatementIsGrounded('ROE remains a useful profitability indicator.', [roe])).toBe(true);
    expect(financialStatementIsGrounded('Q2 2026 and FY 2025 are the relevant periods.', [roe])).toBe(true);

    const revenue = resolveFinancialSemanticFigure({
      kind: 'quarterly_financials', path: 'quarters[0].revenue', periodLabel: '2025-Q4',
      data: { currency: 'IDR', quarters: [{ revenue: 100 }] },
    })!;
    expect(financialStatementIsGrounded('Revenue was IDR one hundred.', [revenue])).toBe(false);
  });

  it.each([
    'ROE was twenty.',
    'Revenue was ten.',
    'P/E was twelve.',
    'Net income was five.',
  ])('fails closed on unsupported direct number-word assertion: %s', statement => {
    const figures = [
      { metric: 'roe', unitClass: 'percent' as const, value: 22.4, periodLabel: '2025' },
      { metric: 'revenue', unitClass: 'currency' as const, currencyCode: 'IDR', value: 100, periodLabel: 'Q4 2025' },
      { metric: 'pe', unitClass: 'multiple' as const, value: 12, periodLabel: '2025' },
      { metric: 'netIncome', unitClass: 'currency' as const, currencyCode: 'IDR', value: 5, periodLabel: 'Q4 2025' },
    ];
    expect(financialStatementIsGrounded(statement, figures)).toBe(false);
  });

  it.each([
    'ROE is one of the monitored metrics.',
    'Revenue has two audited sources.',
    'Revenue in IDR has two audited sources.',
    'Two sources report the same revenue figure.',
  ])('allows ordinary count prose: %s', statement => {
    const revenue = { metric: 'revenue', unitClass: 'currency' as const, currencyCode: 'IDR', value: 100, periodLabel: 'Q4 2025' };
    const roe = { metric: 'roe', unitClass: 'percent' as const, value: 22.4, periodLabel: '2025' };
    expect(financialStatementIsGrounded(statement, [revenue, roe])).toBe(true);
  });

  it('validates an ordinary count independently from a supported digit assertion', () => {
    const revenue = { metric: 'revenue', unitClass: 'currency' as const, currencyCode: 'IDR', value: 100, periodLabel: 'Q4 2025' };
    expect(financialStatementIsGrounded('Two sources report revenue of IDR 100.', [revenue])).toBe(true);
  });

  it('rejects unsupported currency magnitude modifiers without guessing provider scale', () => {
    const revenue = resolveFinancialSemanticFigure({
      kind: 'quarterly_financials', path: 'quarters[0].revenue', periodLabel: '2025-Q4',
      data: { currency: 'IDR', quarters: [{ revenue: 100 }] },
    })!;
    expect(financialStatementIsGrounded('Revenue was IDR 100.', [revenue])).toBe(true);
    for (const magnitude of ['thousand', 'million', 'billion', 'trillion']) {
      expect(financialStatementIsGrounded(`Revenue was IDR 100 ${magnitude}.`, [revenue])).toBe(false);
    }
  });

  it('does not infer growth or net-income identity from generic wording', () => {
    const growth = resolveFinancialSemanticFigure({
      kind: 'company_report', path: 'financials.yoyQuarterRevenueGrowth', periodLabel: '2025-Q4',
      data: { financials: { yoyQuarterRevenueGrowth: 8 } },
    })!;
    expect(financialStatementIsGrounded('Revenue growth was 8%.', [growth])).toBe(true);
    expect(financialStatementIsGrounded('Revenue increased 8%.', [growth])).toBe(false);

    const income = resolveFinancialSemanticFigure({
      kind: 'quarterly_financials', path: 'quarters[0].netIncome', periodLabel: '2025-Q4',
      data: { currency: 'IDR', quarters: [{ netIncome: 20 }] },
    })!;
    expect(financialStatementIsGrounded('Net income was IDR 20.', [income])).toBe(true);
    expect(financialStatementIsGrounded('Profit was IDR 20.', [income])).toBe(false);
  });

  it('does not resolve unsupported current financial paths', () => {
    expect(resolveFinancialSemanticFigure({
      kind: 'company_report', path: 'financials.adjustedEbitda', periodLabel: '2025-12-31',
      data: { financials: { adjustedEbitda: 4 } },
    })).toBeUndefined();
  });
});
