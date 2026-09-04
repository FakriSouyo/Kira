import React from 'react';
import { Box, Text } from 'ink';

export function StepIndicator({ steps, current }: { steps: string[]; current: number }) {
  return (
    <Box gap={2} marginY={1}>
      {steps.map((s, i) => (
        <Box key={s}>
          <Text color={i === current ? 'cyan' : i < current ? 'green' : 'gray'}>
            {i < current ? '●' : i === current ? '○' : '○'} {s}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
