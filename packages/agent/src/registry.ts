/**
 * Skill-registry ringan (Phase 2 Task 4 · addendum §24-B.4, tanpa Cordis).
 *
 * Katalog ini memetakan flag fitur opsional ke section prompt yang bisa
 * disisipkan ke system prompt agent (Bull/Judge). Filter dilakukan terhadap
 * array flag (`--with dividend risk`), BUKAN preset YAML — sebuah flag yang
 * ada di `filterSkills([...])` → `promptSection`-nya ikut ke prompt; tanpa
 * flag, section terkait tidak muncul. `buildSkillPromptSections([])` = `''`.
 *
 * Contract (locked planning/phase-2.md §4): `[{name, description, promptSection,
 * evidenceSources, featureFlag}]` — filter registry, bukan plugin.
 */

/** Satu skill opsional di registry. */
export interface SkillDef {
  /** Slug unik (mis. `"dividend"`) — juga nilai featureFlag yang diaktifkan. */
  name: string;
  /** Satu baris deskripsi untuk user/CLI. */
  description: string;
  /** Canonical evidence sources yang dibaca skill (lihat addendum §24-A). */
  evidenceSources: string[];
  /** Nilai flag yang mengaktifkan skill (`--with <featureFlag>`). */
  featureFlag: string;
  /** Section prompt yang disisipkan ke system prompt agent bila aktif. */
  promptSection: string;
}

const DIVIDEND_SECTION = [
  'Skill — Dividend Analysis:',
  '- Inspect sectors.company_report valuation.dividendYield for the payout profile.',
  '- Assess dividend sustainability from profitability and payout ratio.',
  '- Cite evidence IDs that support the dividend thesis or its absence.',
].join('\n');

const RISK_SECTION = [
  'Skill — Risk Assessment:',
  '- Use sectors.sentiment to weigh downside signals and market mood.',
  '- Flag concentration, valuation, or sentiment risks explicitly.',
  '- Cite evidence IDs backing each risk factor.',
].join('\n');

const TECHNICAL_SECTION = [
  'Skill — Technical Analysis:',
  '- Use sectors.daily_transaction for price/volume trend signals.',
  '- Identify momentum and support/resistance from recent activity.',
  '- Cite evidence IDs for each technical observation.',
].join('\n');

/** Katalog skill default — perluas di sini (bukan plugin terpisah). */
export const SKILLS: SkillDef[] = [
  {
    name: 'dividend',
    description: 'Sector-level dividend yield analysis from valuation payload.',
    evidenceSources: ['sectors.company_report'],
    featureFlag: 'dividend',
    promptSection: DIVIDEND_SECTION,
  },
  {
    name: 'risk',
    description: 'Risk assessment from market/news sentiment signals.',
    evidenceSources: ['sectors.sentiment'],
    featureFlag: 'risk',
    promptSection: RISK_SECTION,
  },
  {
    name: 'technical',
    description: 'Price/volume momentum from daily transaction data.',
    evidenceSources: ['sectors.daily_transaction'],
    featureFlag: 'technical',
    promptSection: TECHNICAL_SECTION,
  },
];

/**
 * Filter registry berdasarkan flag yang diaktifkan (urutan sesuai `flags`).
 * Flag yang tidak dikenal diabaikan. `flags` kosong → `[]` (tanpa section).
 */
export function filterSkills(flags: string[]): SkillDef[] {
  const wanted = new Set(flags);
  return SKILLS.filter((s) => wanted.has(s.featureFlag));
}

/**
 * Gabungkan `promptSection` dari skill yang terfilter menjadi satu string,
 * siap disisipkan ke system prompt agent (zona setelah persona).
 * Tanpa flag aktif → mengembalikan string kosong (section terkait tak muncul).
 */
export function buildSkillPromptSections(flags: string[]): string {
  return filterSkills(flags)
    .map((s) => s.promptSection)
    .join('\n\n');
}