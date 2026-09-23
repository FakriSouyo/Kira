import { asc, eq } from 'drizzle-orm';
import { buildClaimGraph, type ClaimGraph, type ClaimGraphReader } from '@harness/execution';
import { UserFriendlyError } from '@harness/shared';
import type { Orm } from './client';
import { claims, counterpoints, executions } from './schema';
import { toStoredClaim } from './claimStoreSqlite';
import { toStoredCounterpoint } from './counterpointStoreSqlite';

/** Rebuilds execution-local Claim Graphs from canonical Claim and Counterpoint rows. */
export class ClaimGraphReaderSqlite implements ClaimGraphReader {
  constructor(private readonly db: Orm) {}

  async getByExecution(executionId: string): Promise<ClaimGraph> {
    const [execution] = await this.db.select({ id: executions.id }).from(executions)
      .where(eq(executions.id, executionId)).limit(1);
    if (!execution) {
      throw new UserFriendlyError(
        'NOT_FOUND',
        `Run "${executionId}" not found`,
        'Try: /judge BBCA (or other valid ticker)',
      );
    }

    const [claimRows, counterpointRows] = await Promise.all([
      this.db.select().from(claims).where(eq(claims.runId, executionId)).orderBy(asc(claims.claimId)),
      this.db.select().from(counterpoints).where(eq(counterpoints.runId, executionId))
        .orderBy(asc(counterpoints.sourceNodeId), asc(counterpoints.counterpointId)),
    ]);

    return buildClaimGraph({
      executionId,
      claims: claimRows.map(toStoredClaim),
      counterpoints: counterpointRows.map(toStoredCounterpoint),
    });
  }
}
