export * from './types';
export * from './adapter';
export * from './client';
export * from './cache';
export * from './policy';
export * from './mock';

import type { SectorsApi } from './types';
import { SectorsClient } from './client';
import { MockSectorsApi } from './mock';
import type { SectorsApiOptions } from './client';
import type { FinancialDataProvider } from '@harness/financial-data';
import { SectorsFinancialDataProvider } from './adapter';

/** Factory sesuai config (addendum §12: mock_mode). */
export function createSectorsApi(options: SectorsApiOptions & { mock?: boolean }): SectorsApi {
  return options.mock ? new MockSectorsApi() : new SectorsClient(options);
}

/** Composition factory for the provider-neutral financial data seam. */
export function createSectorsFinancialDataProvider(
  options: SectorsApiOptions & { mock?: boolean },
): FinancialDataProvider {
  return new SectorsFinancialDataProvider(createSectorsApi(options));
}
