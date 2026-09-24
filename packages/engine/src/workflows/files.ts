import type { CapabilityGateway } from '@harness/capability';
import type { Attachment } from '@harness/schemas';
import { COMMAND_FILES_CAPABILITY_PRINCIPAL } from '../capabilities/attachment.js';
import { attachmentToolIds } from '../tools/attachment.js';

export interface FilesArtifacts {
  readonly attachments: readonly Attachment[];
}

export async function filesWorkflow(
  capabilityGateway: CapabilityGateway,
  options: { readonly signal?: AbortSignal } = {},
): Promise<FilesArtifacts> {
  const { value: attachments } = await capabilityGateway.invoke(
    COMMAND_FILES_CAPABILITY_PRINCIPAL,
    attachmentToolIds.list,
    {},
    { signal: options.signal },
  );

  return { attachments };
}
