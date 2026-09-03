import type { JudgeArtifacts } from '../workflows/judgeWorkflow';
import type { ScreenArtifacts } from '../workflows/screenWorkflow';
import type { ExecutionArtifacts } from '@harness/execution';
import { normalizeJudgmentScore } from '@harness/shared';
import type { UserFriendlyError } from '@harness/shared';

/**
 * Output conversational (addendum §19) — icon per agent + warna.
 * Warna nonaktif bila stdout bukan TTY atau NO_COLOR di-set (aman untuk pipe/E2E).
 */
const useColor = Boolean(process.stdout.isTTY) && !('NO_COLOR' in process.env);

const paint = (code: string) => (s: string): string => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const color = {
  blue: paint('34'),
  green: paint('32'),
  yellow: paint('33'),
  red: paint('31'),
  cyan: paint('36'),
  bold: paint('1'),
  dim: paint('2'),
  gray: paint('90'),
};

const HEAVY = '━'.repeat(58);
const LIGHT = '─'.repeat(58);

export function renderBanner(homeDir: string, mockSectors: boolean, mockLlm: boolean): string {
  const lines = [
    HEAVY,
    `  ${color.cyan(color.bold('⚡ Financial Agent Harness v0.1.0'))}`,
    `  Evidence-based stock research system`,
    `  Type ${color.green('/help')} for available commands`,
    `  Data dir: ${color.gray(homeDir)}`,
  ];
  if (mockSectors || mockLlm) {
    const parts = [mockSectors && 'mock sectors', mockLlm && 'mock LLM'].filter(Boolean);
    lines.push(`  ${color.yellow(`⚠ Mock mode active: ${parts.join(' + ')} (offline development)`)}`);
  }
  lines.push(HEAVY);
  return lines.join('\n');
}

export function renderHelp(): string {
  return [
    color.bold('Financial Agent Harness Commands'),
    '',
    color.bold('Core:'),
    `  ${color.green('/judge [TICKER]')}     Full analysis + Debate ronde (Researcher → Bull → Bear → Bull → Judge)`,
    `  ${color.green('/screen [CRITERIA]')}  Screen stocks (profitable, growing)`,
    `  ${color.green('/auth-set KEY=VALUE')} Save API keys to .credentials.json (SECTORS/LLM.AGENT/LLM.ROUTER)`,
    `  ${color.green('/help')}               Show this help`,
    `  ${color.green('/exit')}               Exit harness`,
    '',
    color.bold('Roadmap (coming soon):'),
    `  /challenge [CLAIM]   Test specific claim`,
    `  /compare [TICKERS]   Compare multiple stocks`,
    `  /research [TICKER]   Raw research without judgment`,
    '',
    color.bold('Natural Language:'),
    `  You can also ask questions naturally:`,
    `  > "Saham apa yang konsisten tumbuh?"`,
    `  > "Apakah BBCA layak dibeli?"`,
    '',
    color.bold('Tips:'),
    '  - Press Tab for slash-command autocomplete',
    '  - Press Ctrl+C twice (or /exit) to quit',
  ].join('\n');
}

export function renderStub(command: string): string {
  return [
    color.yellow(`⚠  /${command} is in active development.`),
    '',
    'For now, you can:',
    '- Use /judge BBCA to see a full analysis',
    '- Ask natural language: "Is BBCA overvalued?"',
  ].join('\n');
}

export function renderUnknownCommand(command: string): string {
  return color.red(`✗ Unknown command: /${command}`) + '\n' + color.gray(`Try ${'/help'} to list available commands.`);
}

let progressPhase: string | null = null;

export function resetProgress(): void {
  progressPhase = null;
}

const PHASE_HEADERS: Record<string, string> = {
  researcher: color.blue(color.bold('🔍 RESEARCHER')),
  bull: color.green(color.bold('🐂 BULL AGENT')),
  bear: color.red(color.bold('🐻 BEAR AGENT')),
  judge: color.yellow(color.bold('⚖️ JUDGE')),
};

/** Progress per fase workflow (dipanggil judgeWorkflow saat berjalan). */
export function writeProgress(output: NodeJS.WritableStream, phase: string, line: string): void {
  if (phase !== progressPhase) {
    output.write(`\n${PHASE_HEADERS[phase] ?? phase}\n`);
    progressPhase = phase;
  }
  output.write(`  ${line}\n`);
}

/** Output penuh /judge — layout conversational addendum §19 + Debate ronde (Phase 1). */
export function renderJudgeResult(artifacts: JudgeArtifacts): string {
  const { run, evidence, marketEvidence, newsEvidence, marketAvailable, newsAvailable, bull, bear, rebuttal, judgment } = artifacts;
  const ev = (id: string) => color.gray(id);
  const breakdown = judgment.breakdown;
  const b = (v: number | null, label: string) =>
    `    ${label.padEnd(20)} ${v === null ? color.gray('-- (not evaluated: data unavailable)') : `${v} / 100`}`;
  const claimIndex = new Map(bull.claims.map((c, i) => [c.claimId, i + 1]));

  return [
    HEAVY,
    `  ${color.bold('FINANCIAL AGENT HARNESS')}`,
    `  ${run.ticker} · Multi-Agent Analysis`,
    HEAVY,
    '',
    `🔍 RESEARCHER`,
    `  Evidence: ${ev(evidence[0]?.id ?? '-')}, ${ev(evidence[1]?.id ?? '-')}`,
    ...(marketAvailable && marketEvidence.length > 0
      ? [`  Market: ${marketEvidence.map((e) => ev(e.id)).join(', ')}`]
      : [`  ${color.gray('Market: unavailable — marketMomentum left unevaluated')}`]),
    ...(newsAvailable && newsEvidence.length > 0
      ? [`  News: ${newsEvidence.map((e) => ev(e.id)).join(', ')}`]
      : [`  ${color.gray('News: unavailable — risk left unevaluated')}`]),
    '',
    LIGHT,
    '',
    `🐂 BULL AGENT`,
    ...indent(bull.reasoning),
    '',
    ...bull.claims.flatMap((c, i) => [
      `  ${color.green(`→ Claim #${i + 1} (${c.confidence})`)}`,
      `    ${color.bold(`"${c.statement}"`)}`,
      `    ${color.gray(`Evidence: ${c.evidenceIds.join(', ')}`)}`,
      `    ${color.dim(c.reasoning)}`,
      '',
    ]),
    LIGHT,
    '',
    `🐻 BEAR AGENT`,
    ...indent(bear.reasoning),
    '',
    ...bear.counterpoints.flatMap((cp, i) => [
      `  ${color.red(`→ Challenge #${i + 1} (${cp.strength})`)}${claimIndex.has(cp.targetClaimId) ? color.gray(` — targets Claim #${claimIndex.get(cp.targetClaimId)}`) : color.gray(` — targets ${cp.targetClaimId}`)}`,
      `    ${color.bold(`"${cp.argument}"`)}`,
      '',
    ]),
    LIGHT,
    '',
    `🐂 BULL AGENT — REBUTTAL`,
    ...indent(rebuttal.reasoning),
    '',
    ...rebuttal.claims.flatMap((c, i) => [
      `  ${color.green(`→ Claim #${i + 1} (${c.confidence})`)}`,
      `    ${color.bold(`"${c.statement}"`)}`,
      `    ${color.gray(`Evidence: ${c.evidenceIds.join(', ')}`)}`,
      `    ${color.dim(c.reasoning)}`,
      '',
    ]),
    LIGHT,
    '',
    `⚖️ JUDGE`,
    ...indent(judgment.summary),
    '',
    `  ${color.bold(`→ Decision: ${judgment.stance.toUpperCase()}`)}`,
    '',
    LIGHT,
    '',
    `             ${color.bold(`${run.ticker} · FINAL JUDGMENT`)}`,
    '',
    `  ${'Score'.padEnd(14)} ${color.bold(`${judgment.score} / 100`)}`,
    `  ${'Stance'.padEnd(14)} ${judgment.stance.toUpperCase()}`,
    `  ${'Confidence'.padEnd(14)} ${judgment.confidence.toUpperCase()}`,
    '',
    `  Breakdown:`,
    b(breakdown.financialHealth, 'Financial Health'),
    b(breakdown.growth, 'Growth'),
    b(breakdown.valuation, 'Valuation'),
    b(breakdown.marketMomentum, 'Market Momentum'),
    b(breakdown.risk, 'Risk'),
    '',
    `  ${'Run ID'.padEnd(14)} ${color.gray(run.id)}`,
    `  ${'Time'.padEnd(14)} ${(run.executionTime ?? 0).toFixed(1)}s`,
    '',
    HEAVY,
  ].join('\n');
}

/** Output /screen — ranking historis, bukan prediksi (addendum §18). */
export function renderScreenResult(artifacts: ScreenArtifacts): string {
  const { criteria, results } = artifacts;
  if (results.length === 0) {
    return [
      `Screening stocks: ${criteria.join(' + ') || '(no criteria)'}`,
      '',
      color.yellow('No stocks matched the criteria.'),
      color.gray('Historical pattern analysis only — not a prediction.'),
    ].join('\n');
  }
  return [
    `Screening stocks: ${criteria.join(' + ')}`,
    '',
    color.bold('Results:'),
    ...results.map(
      (r, i) =>
        `  ${i + 1}. ${color.bold(r.ticker)} (${r.matchScore}/100)` +
        (r.roe !== undefined ? color.dim(` — ROE ${r.roe}%`) : '') +
        (r.revenueGrowthYoy !== undefined ? color.dim(`, Growth ${r.revenueGrowthYoy}%`) : ''),
    ),
    '',
    color.gray('[View details: /judge TICKER] · Historical patterns, not predictions'),
  ].join('\n');
}

/** Error ramah user (addendum §21). */
export function renderError(error: UserFriendlyError): string {
  return [
    color.red(`✗ Error: ${color.bold(error.code)}`),
    '',
    error.message,
    '',
    color.gray(`Suggestion: ${error.suggestion}`),
  ].join('\n');
}

/** Export JSON — DB rows verbatim (addendum §27 export). */
export function renderExportJson(artifacts: ExecutionArtifacts): string {
  return JSON.stringify(
    {
      run: artifacts.run,
      evidence: artifacts.evidence,
      messages: artifacts.messages,
      claims: artifacts.claims,
      judgment: artifacts.judgment,
    },
    null,
    2,
  );
}

/** Export Markdown — audit trail lengkap, dipakai /export --format md. */
export function renderExportMarkdown(artifacts: ExecutionArtifacts): string {
  const { run, evidence, messages, claims, judgment } = artifacts;
  const j = judgment;
  const score = j ? `${j.score} / 100` : '--';
  const stance = j?.stance?.toUpperCase() ?? '--';
  const breakdown = j?.breakdown;
  const b = (v: number | null | undefined, label: string) =>
    `| ${label} | ${v == null ? '-- (not evaluated)' : `${v} / 100`} |`;
  return [
    `# ${run.ticker} · FINAL JUDGMENT`,
    '',
    `Run: \`${run.id}\` · Ticker: ${run.ticker} · Status: ${run.status}`,
    '',
    `**Score:** ${score} · **Stance:** ${stance} · **Confidence:** ${j?.confidence?.toUpperCase() ?? '--'}`,
    '',
    '## Breakdown',
    '',
    '| Category | Score |',
    '|---|---|',
    b(breakdown?.financialHealth, 'Financial Health'),
    b(breakdown?.growth, 'Growth'),
    b(breakdown?.valuation, 'Valuation'),
    b(breakdown?.marketMomentum, 'Market Momentum'),
    b(breakdown?.risk, 'Risk'),
    '',
    '## Evidence',
    '',
    ...evidence.map((e) => `- \`${e.id}\` · ${e.source} · ${e.ticker}`),
    ...(evidence.length === 0 ? ['- (none)'] : []),
    '',
    '## Conversation',
    '',
    ...messages.map((m) => `- [${m.sequenceOrder}] ${m.agent} (${m.messageType}): ${m.messageId}`),
    ...(messages.length === 0 ? ['- (none)'] : []),
    '',
    '## Claims',
    '',
    ...claims.map((c) => `- \`${c.claimId}\` (${c.confidence}): ${c.statement}`),
    ...(claims.length === 0 ? ['- (none)'] : []),
    '',
    j?.summary ? `> ${j.summary}` : '',
  ].join('\n');
}

/** Export HTML — wrapper sederhana di atas data yang sama. */
export function renderExportHtml(artifacts: ExecutionArtifacts): string {
  const md = renderExportMarkdown(artifacts);
  const escaped = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${artifacts.run.ticker} · FINAL JUDGMENT</title></head><body><pre>${escaped}</pre></body></html>`;
}

function indent(text: string): string[] {
  return text.split('\n').map((line) => (line === '' ? '' : `  ${line}`));
}
