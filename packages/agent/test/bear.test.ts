import { UserFriendlyError } from '@harness/shared';
import { describe, expect, it } from 'vitest';
import { BearAgent } from '../src/index';

describe('BearAgent (Phase 0 — stub, addendum Task 11)', () => {
  it('throws a user-friendly error when invoked in Phase 0', async () => {
    const bear = new BearAgent();
    await expect(bear.challenge({ ticker: 'BBCA' })).rejects.toMatchObject({
      code: 'BEAR_NOT_AVAILABLE',
    });
    await expect(bear.challenge({})).rejects.toBeInstanceOf(UserFriendlyError);
  });
});
