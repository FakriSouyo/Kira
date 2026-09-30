import { z } from 'zod';
import { CitedFigureSchema } from '@harness/schemas';

export const ResearchFindingSchema = z.object({
  claim: z.string().min(1),
  evidenceIds: z.array(z.string().uuid()).min(1),
  confidence: z.enum(['high', 'medium', 'low']),
  citedFigures: z.array(CitedFigureSchema).optional(),
});

export const SourceAssessmentSchema = z.object({
  evidenceId: z.string().uuid(),
  quality: z.enum(['primary', 'secondary', 'weak']),
  rationale: z.string().min(1),
});

/** Structured boundary prevents the researcher from emitting uncited findings. */
export const ResearcherOutputSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(ResearchFindingSchema),
  sourceAssessments: z.array(SourceAssessmentSchema),
  gaps: z.array(z.string().min(1)),
});

export type ResearcherOutput = z.infer<typeof ResearcherOutputSchema>;
