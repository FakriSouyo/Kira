export * from './types';
export * from './client';
export * from './cache';
export * from './mock';

import type { SectorsApi } from './types';
import { SectorsClient } from './client';
import { MockSectorsApi } from './mock';
import type { SectorsApiOptions } from './client';

/** Factory sesuai config (addendum §12: mock_mode). */
export function createSectorsApi(options: SectorsApiOptions & { mock?: boolean }): SectorsApi {
  return options.mock ? new MockSectorsApi() : new SectorsClient(options);
}
