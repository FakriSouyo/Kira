import { UserFriendlyError } from '@harness/shared';

/**
 * Bear Agent — reserved Phase 1 ("Debate ronde", addendum §15/Task 11).
 * Keputusan terkunci: Phase 0 menjalankan 3-agent flow (Researcher → Bull → Judge).
 * Kelas ini hanya stub spesifikasi; skema DB sudah mem-reserve agent 'bear'
 * dan message type 'challenge'/'response' supaya Phase 1 tidak butuh migrasi.
 */
export class BearAgent {
  async challenge(_params: unknown): Promise<never> {
    throw new UserFriendlyError(
      'BEAR_NOT_AVAILABLE',
      'Bear agent is part of Phase 1 (Debate ronde) and is not available in Phase 0.',
      'Use /judge TICKER for the full Phase 0 analysis.',
    );
  }
}
