import React from 'react';
import { Box, Text } from 'ink';
import type { ConnectionResult } from '../service';

export function ConnectionTest({ result }: { result: ConnectionResult | null }) {
  if (!result) {
    return (
      <Box>
        <Text>◇ Testing configuration...</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text color={result.sectors.ok ? 'green' : 'red'}>{result.sectors.ok ? '✓' : '✗'} Sectors API{result.sectors.error ? ` — ${result.sectors.error}` : ''}</Text>
      <Text color={result.agent.ok ? 'green' : 'red'}>{result.agent.ok ? '✓' : '✗'} Agent model{result.agent.error ? ` — ${result.agent.error}` : ''}</Text>
      <Text color={result.router.ok ? 'green' : 'red'}>{result.router.ok ? '✓' : '✗'} Router model{result.router.error ? ` — ${result.router.error}` : ''}</Text>
    </Box>
  );
}
