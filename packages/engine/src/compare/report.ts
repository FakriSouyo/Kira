import { ComparisonReportPayloadSchema, type ComparisonMatrix, type ComparisonReportPayload } from '@harness/schemas';

/** Builds the exact version 1 report payload through its strict schema. */
export function buildComparisonReportPayload(matrix: ComparisonMatrix): ComparisonReportPayload {
  return ComparisonReportPayloadSchema.parse(matrix);
}
