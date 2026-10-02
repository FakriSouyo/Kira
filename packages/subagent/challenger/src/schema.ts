import { z } from 'zod';
import {
  ChallengeCitedFigureInputSchema,
  ChallengeSourceAssessmentSchema,
  ChallengeSourceCoverageSchema,
} from '@harness/schemas';

export const ChallengeAnalystFindingSchema = z.object({
  statement: z.string().min(1),
  evidenceIds: z.array(z.string().uuid()).min(1).refine(ids => new Set(ids).size === ids.length, {
    message: 'Challenge finding Evidence IDs must be unique',
  }),
  confidence: z.enum(['high', 'medium', 'low']),
  citedFigures: z.array(ChallengeCitedFigureInputSchema).optional(),
}).strict();
export type ChallengeAnalystFinding = z.infer<typeof ChallengeAnalystFindingSchema>;

const ChallengeAnalystShape = z.object({
  thesis: z.string().min(1),
  summary: z.string().min(1),
  supportingCase: z.array(ChallengeAnalystFindingSchema),
  counterCase: z.array(ChallengeAnalystFindingSchema),
  unsupportedAssumptions: z.array(z.string().min(1)),
  failureConditions: z.array(z.string().min(1)),
  evidenceThatWouldChangeThesis: z.array(z.string().min(1)),
  sourceAssessments: z.array(ChallengeSourceAssessmentSchema),
  gaps: z.array(z.string().min(1)),
  coverage: z.array(ChallengeSourceCoverageSchema).min(1),
}).strict();

export const ChallengeAnalystOutputSchema = ChallengeAnalystShape.superRefine((output, context) => {
  if (output.supportingCase.length + output.counterCase.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['supportingCase'],
      message: 'Challenge analyst output requires at least one finding',
    });
  }
});
export type ChallengeAnalystOutput = z.infer<typeof ChallengeAnalystOutputSchema>;
