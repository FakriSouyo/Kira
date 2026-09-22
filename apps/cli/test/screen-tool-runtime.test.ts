import { describe, expect, it, vi } from 'vitest';
import { ToolRuntime } from '@harness/tool-runtime';
import type { FinancialDataProvider, ScreenerResult } from '@harness/financial-data';
import { createApplicationCapabilityGateway } from '../src/tools/applicationCapabilities';
import { createAttachmentTools } from '../src/tools/attachmentTools';
import { createDocumentTools } from '../src/tools/documentTools';
import { createFinancialTools } from '../src/tools/financialTools';
import { screenWorkflow } from '../src/workflows/screenWorkflow';
import type { HarnessContext } from '../src/context';

describe('Screen tool-runtime composition', () => {
  it('invokes financial.screen and retains only positive matches up to ten rows', async () => {
    const rows: ScreenerResult[] = Array.from({ length: 12 }, (_, index) => ({
      ticker: `T${index}`,
      matchScore: index === 0 ? 0 : index,
    }));
    const provider = {
      screen: vi.fn(async () => rows),
    } as unknown as FinancialDataProvider;
    const toolRuntime = new ToolRuntime();
    const financialTools = createFinancialTools(provider);
    const context = {
      capabilityGateway: createApplicationCapabilityGateway({
        financialTools,
        attachmentTools: createAttachmentTools({ attachmentStore: {} as never, sessionId: 'test-session' }),
        documentTools: createDocumentTools({ documentStore: {} as never, sessionId: 'test-session' }),
        toolRuntime,
      }),
    } as unknown as HarnessContext;

    await expect(screenWorkflow(context, ['profitable'])).resolves.toEqual({
      criteria: ['profitable'],
      results: rows.slice(1, 11),
    });
    expect(provider.screen).toHaveBeenCalledWith(['profitable']);
  });
});
