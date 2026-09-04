import React from 'react';
import SelectInput from 'ink-select-input';
import type { ProviderId } from '../providers';
import { PROVIDERS } from '../providers';

export function ProviderSelector({ onSelect }: { onSelect: (id: ProviderId) => void }) {
  const items = PROVIDERS.map((p) => ({ label: p.label, value: p.id as ProviderId }));
  return <SelectInput items={items as never} onSelect={(item: { value: ProviderId }) => onSelect(item.value)} />;
}
