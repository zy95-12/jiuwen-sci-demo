import { createId } from "./ids.js";
import type { RuntimeServices, ToolContext, WorkflowContext } from "./types.js";

export function createInternalToolContext(services: RuntimeServices, sessionId: string, agentId: string): ToolContext {
  const toolCallId = createId("call");
  return {
    runtime: services, sessionId, agentId, toolCallId,
    emit: (event) => services.eventBus.emit(event),
    createArtifact: (artifactInput) => services.artifactStore.create({ ...artifactInput, sessionId, createdBy: { sessionId, agentId, toolId: "internal" } }),
    recordProvenance: (prov) => services.provenanceStore.record(prov)
  };
}

export function createWorkflowContext(services: RuntimeServices, sessionId: string, taskTool: { execute(ctx: ToolContext, input: any): Promise<any> }): WorkflowContext {
  return {
    sessionId, services,
    task: (input) => taskTool.execute(createInternalToolContext(services, sessionId, "workflow"), input),
    createArtifact: (artifactInput) => services.artifactStore.create({ ...artifactInput, sessionId, createdBy: { sessionId, agentId: "workflow", toolId: "workflow" } }),
    recordProvenance: (prov) => services.provenanceStore.record(prov)
  };
}
