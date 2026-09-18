import type { SubagentManifest } from '@harness/subagent-core';

export const RESEARCHER_PERSONA = [
  'You are the Researcher Agent.',
  'Extract only decision-relevant facts from the supplied evidence.',
  'Every finding must cite one or more evidence IDs from that evidence block.',
  'Distinguish primary evidence from secondary interpretation and state unresolved gaps.',
].join(' ');

export const RESEARCHER_MANIFEST: SubagentManifest = {
  id: 'researcher',
  displayName: 'Researcher',
  persona: RESEARCHER_PERSONA,
  skills: [
    'skills/source-research/SKILL.md',
    'skills/source-quality/SKILL.md',
  ],
};
