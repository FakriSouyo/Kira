import { ToolRuntime } from '@harness/tool-runtime';
import type { AttachmentStore } from '@harness/session-core';
import type { DocumentStore } from '@harness/document';
import type { FinancialDataProvider } from '@harness/financial-data';
import { createApplicationCapabilityGateway } from './capabilities/application';
import { createAttachmentTools } from './tools/attachment';
import { createDocumentTools } from './tools/document';
import { createFinancialTools } from './tools/financial';
import { createJudgeCapabilityPlan } from './capabilities/financial';

export { attachmentToolIds } from './tools/attachment';
export { documentToolIds } from './tools/document';
export { financialToolIds } from './tools/financial';
export {
  COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL,
  COMMAND_FILES_CAPABILITY_PRINCIPAL,
} from './capabilities/attachment';
export { COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL } from './capabilities/document';
export {
  JUDGE_CAPABILITY_PRINCIPALS,
  SCREEN_CAPABILITY_PRINCIPAL,
} from './capabilities/financial';
export { createConversationContextCoordinator } from './conversation/contextCoordinator.js';
export type {
  ConversationContextBudgetOptions,
  ConversationContextCoordinator,
  PreparedConversationContext,
} from './conversation/contextCoordinator.js';
export { createWorkingContextPublisher } from './session/workingContextPublisher.js';
export type {
  WorkingContextPublisher,
  WorkingContextPublishStatus,
} from './session/workingContextPublisher.js';
export { WorkflowTraceRecorder } from './runtime/workflowTraceRecorder';
export type {
  TraceableWorkflowDefinition,
  WorkflowTraceRecorderOptions,
} from './runtime/workflowTraceRecorder';
export { screenWorkflow } from './workflows/screen';
export type { ScreenArtifacts } from './workflows/screen';
export { filesWorkflow } from './workflows/files.js';
export type { FilesArtifacts } from './workflows/files.js';
export { documentIndexWorkflow, documentSearchWorkflow } from './workflows/document.js';
export type { DocumentSearchArtifacts } from './workflows/document.js';

export interface EngineCapabilityRuntimeOptions {
  readonly financialData: FinancialDataProvider;
  readonly attachmentStore: AttachmentStore;
  readonly documentStore: DocumentStore;
  readonly sessionId: string;
}

/** Composes one host-neutral, Session-scoped capability runtime for an application context. */
export function createEngineCapabilityRuntime({
  financialData,
  attachmentStore,
  documentStore,
  sessionId,
}: EngineCapabilityRuntimeOptions) {
  const financialTools = createFinancialTools(financialData);
  const attachmentTools = createAttachmentTools({ attachmentStore, sessionId });
  const documentTools = createDocumentTools({ documentStore, sessionId });
  const capabilityGateway = createApplicationCapabilityGateway({
    financialTools,
    attachmentTools,
    documentTools,
    toolRuntime: new ToolRuntime(),
  });

  return {
    capabilityGateway,
    judgeCapabilityPlan: createJudgeCapabilityPlan(capabilityGateway),
  };
}

export type EngineCapabilityRuntime = ReturnType<typeof createEngineCapabilityRuntime>;
