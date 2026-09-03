import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/commands/version';
import { renderBanner, renderHelp } from '../src/repl/renderer';

describe('/version + banner (Phase 5 Task 1)', () => {
  it('VERSION is semver-like', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('banner contains version', () => {
    const banner = renderBanner('/tmp', false, false, VERSION);
    expect(banner).toContain(`v${VERSION}`);
  });

  it('help contains phase 4/5 commands', () => {
    const help = renderHelp();
    expect(help).toContain('/history');
    expect(help).toContain('/session');
    expect(help).toContain('/web');
    expect(help).toContain('/export');
    expect(help).toContain('/version');
  });
});
