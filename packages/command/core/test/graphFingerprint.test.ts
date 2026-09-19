import { describe, expect, it } from 'vitest';
import {
  workflowGraphFingerprint,
  type WorkflowDefinition,
  type WorkflowNode,
} from '../src/index.js';

type Context = Record<string, never>;

function node(
  id: string,
  dependsOn: string[] = [],
  options: Partial<Pick<WorkflowNode<Context>, 'required' | 'label' | 'run'>> = {},
): WorkflowNode<Context> {
  return {
    id,
    label: options.label ?? id,
    dependsOn,
    executor: { kind: 'service', id: `service-${id}` },
    required: options.required,
    run: options.run ?? (async () => id),
  };
}

function graph(nodes: WorkflowNode<Context>[]): WorkflowDefinition<Context> {
  return { id: 'fingerprint-test', nodes };
}

describe('workflowGraphFingerprint', () => {
  it('is deterministic for identical graphs and ignores labels and function source', () => {
    const first = graph([
      node('research', [], { label: 'Research', run: async function firstSource() { return 'first'; } }),
      node('summary', ['research'], { label: 'Summary', run: async function secondSource() { return 'summary'; } }),
    ]);
    const sameGraph = graph([
      node('research', [], { label: 'Renamed research', run: async function changedSource() { return 'different'; } }),
      node('summary', ['research'], { label: 'Renamed summary', run: async function anotherSource() { return 'changed'; } }),
    ]);

    expect(workflowGraphFingerprint(first, 1)).toBe(workflowGraphFingerprint(sameGraph, 1));
  });

  it('changes when a dependency changes', () => {
    const first = graph([node('research'), node('summary', ['research'])]);
    const changed = graph([node('research'), node('summary')]);

    expect(workflowGraphFingerprint(first, 1)).not.toBe(workflowGraphFingerprint(changed, 1));
  });

  it('changes when a node is added or removed', () => {
    const first = graph([node('research'), node('summary', ['research'])]);
    const added = graph([node('research'), node('audit'), node('summary', ['research', 'audit'])]);
    const removed = graph([node('research')]);

    expect(workflowGraphFingerprint(first, 1)).not.toBe(workflowGraphFingerprint(added, 1));
    expect(workflowGraphFingerprint(first, 1)).not.toBe(workflowGraphFingerprint(removed, 1));
  });

  it('changes when a node becomes optional', () => {
    const requiredByDefault = graph([node('research')]);
    const requiredExplicitly = graph([node('research', [], { required: true })]);
    const optional = graph([node('research', [], { required: false })]);

    expect(workflowGraphFingerprint(requiredByDefault, 1)).toBe(workflowGraphFingerprint(requiredExplicitly, 1));
    expect(workflowGraphFingerprint(requiredByDefault, 1)).not.toBe(workflowGraphFingerprint(optional, 1));
  });
});
