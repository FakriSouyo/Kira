import React from 'react';
import SelectInput from 'ink-select-input';

export function ModelSelector({
  models,
  onSelect,
}: {
  models: Array<{ id: string; label: string }>;
  onSelect: (id: string) => void;
}) {
  const items = models.map((m) => ({ label: m.label, value: m.id }));
  return <SelectInput items={items as never} onSelect={(item: { value: string }) => onSelect(item.value)} />;
}
