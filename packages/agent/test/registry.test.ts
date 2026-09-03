import { describe, expect, it } from 'vitest';
import { buildSkillPromptSections, filterSkills, SKILLS } from '../src/index';

describe('Skill-registry (Phase 2 Task 4)', () => {
  it('has at least 3 skills and each exposes the required fields', () => {
    expect(SKILLS.length).toBeGreaterThanOrEqual(3);
    for (const skill of SKILLS) {
      expect(typeof skill.name).toBe('string');
      expect(typeof skill.description).toBe('string');
      expect(Array.isArray(skill.evidenceSources)).toBe(true);
      expect(typeof skill.featureFlag).toBe('string');
      expect(typeof skill.promptSection).toBe('string');
      expect(skill.promptSection.length).toBeGreaterThan(0);
    }
  });

  it('filterSkills(["dividend"]) contains the dividend skill', () => {
    const filtered = filterSkills(['dividend']);
    expect(filtered.map((s) => s.name)).toContain('dividend');
    expect(filtered.map((s) => s.featureFlag)).toEqual(['dividend']);
  });

  it('filterSkills(["dividend", "risk"]) returns dividend + risk only (not technical)', () => {
    const filtered = filterSkills(['dividend', 'risk']);
    const names = filtered.map((s) => s.name);
    expect(names).toEqual(['dividend', 'risk']);
    expect(names).not.toContain('technical');
  });

  it('filterSkills([]) returns an empty array', () => {
    expect(filterSkills([])).toEqual([]);
  });

  it('buildSkillPromptSections(["dividend"]) contains the word dividendYield', () => {
    const sections = buildSkillPromptSections(['dividend']);
    expect(sections).toContain('dividendYield');
    expect(sections).toContain('dividend');
  });

  it('buildSkillPromptSections([]) (no flag) does not contain dividendYield', () => {
    expect(buildSkillPromptSections([])).not.toContain('dividendYield');
  });

  it('an unknown flag is ignored (no section emitted)', () => {
    expect(buildSkillPromptSections(['esg'])).toBe('');
  });

  it('skills reference canonical sectors evidence sources', () => {
    const dividend = SKILLS.find((s) => s.name === 'dividend');
    expect(dividend?.evidenceSources).toContain('sectors.company_report');
    const risk = SKILLS.find((s) => s.name === 'risk');
    expect(risk?.evidenceSources).toContain('sectors.sentiment');
    const technical = SKILLS.find((s) => s.name === 'technical');
    expect(technical?.evidenceSources).toContain('sectors.daily_transaction');
  });
});