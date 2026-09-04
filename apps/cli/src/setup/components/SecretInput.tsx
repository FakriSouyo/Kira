import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

export function SecretInput({
  value,
  onChange,
  onSubmit,
  placeholder = 'sk-',
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <Box>
      <Text>› </Text>
      <TextInput value={value} onChange={onChange} onSubmit={onSubmit} mask="•" placeholder={placeholder} />
    </Box>
  );
}
