import { AgentSessionRunner } from "./agent-session-runner.js";
import { RuntimeError } from "./errors.js";
import type { TaskInput, TaskOutput, ToolDefinition } from "./types.js";

const objectSchema = { type: "object" };
const stringProp = { type: "string", minLength: 1 };

export const artifactWriteTool: ToolDefinition<any, any> = {
  id: "artifact_write", name: "Artifact Write", description: "Create an artifact. Prefer passing content as a string; if omitted, structured fields are serialized as JSON.", inputSchema: { type: "object", properties: { type: stringProp, mediaType: stringProp, content: { type: "string" }, name: stringProp } }, outputSchema: objectSchema, permission: { kind: "runtime" },
  async execute(ctx, input) {
    const hasExplicitContent = typeof input.content === "string";
    const structured = Object.fromEntries(Object.entries(input).filter(([key]) => !["type", "mediaType", "name", "content"].includes(key)));
    const inferredJson = Object.keys(structured).length > 0;
    const type = input.type ?? (inferredJson ? "json" : "markdown");
    const mediaType = input.mediaType ?? (type === "json" ? "application/json" : "text/markdown");
    const content = hasExplicitContent ? input.content : (inferredJson ? JSON.stringify(structured, null, 2) : "");
    const artifact = await ctx.createArtifact({ type, mediaType, content });
    await ctx.recordProvenance({ nodes: [{ type: "artifact", refId: artifact.id, label: input.name ?? "Artifact" }, { type: "tool_call", refId: ctx.toolCallId, label: ctx.toolCallId }], edges: [{ type: "created", fromRef: ctx.toolCallId, toRef: artifact.id }] });
    return { artifactId: artifact.id, path: artifact.path, size: artifact.size };
  }
};

export const artifactReadTool: ToolDefinition<any, any> = {
  id: "artifact_read", name: "Artifact Read", description: "Read artifact text.", inputSchema: { type: "object", required: ["artifactId"], properties: { artifactId: stringProp } }, outputSchema: objectSchema, permission: { kind: "runtime" },
  async execute(ctx, input) {
    const bytes = await ctx.runtime.artifactStore.read(String(input.artifactId));
    return { artifactId: input.artifactId, content: bytes.toString("utf8") };
  }
};

export const reviewFindingWriteTool: ToolDefinition<any, any> = {
  id: "review_finding_write", name: "Review Finding Write", description: "Record a review finding.", inputSchema: { type: "object", required: ["description"], properties: { severity: stringProp, category: stringProp, targetType: stringProp, targetRef: stringProp, description: stringProp, suggestedAction: stringProp } }, outputSchema: objectSchema, permission: { kind: "runtime" },
  async execute(ctx, input) {
    const finding = await ctx.runtime.reviewStore.create({ sessionId: ctx.sessionId, severity: input.severity ?? "minor", category: input.category ?? "general", targetType: input.targetType ?? "session", targetRef: input.targetRef ?? ctx.sessionId, description: String(input.description ?? "Review finding"), suggestedAction: input.suggestedAction });
    await ctx.recordProvenance({ nodes: [{ type: "review", refId: finding.id, label: finding.description }], edges: [] });
    return { findingId: finding.id, severity: finding.severity };
  }
};

export const finalizeTool: ToolDefinition<any, any> = {
  id: "finalize", name: "Finalize", description: "Finalize the current session output.", inputSchema: { type: "object", properties: { finalText: { type: "string" }, output: { type: "string" }, answer: { type: "string" }, content: { type: "string" }, text: { type: "string" }, acceptRisk: { type: "boolean" } } }, outputSchema: objectSchema, permission: { kind: "runtime" },
  async execute(ctx, input) {
    const blocking = await ctx.runtime.reviewStore.listOpenBlocking(ctx.sessionId);
    if (blocking.length && !input.acceptRisk) return { status: "blocked", output: "", blockingFindingIds: blocking.map((f) => f.id) };
    if (blocking.length && input.acceptRisk) await ctx.runtime.reviewStore.acceptRisk(blocking.map((f) => f.id));
    const finalText = String(input.finalText ?? input.output ?? input.answer ?? input.content ?? input.text ?? "");
    const artifact = await ctx.createArtifact({ type: "markdown", mediaType: "text/markdown", content: finalText });
    await ctx.recordProvenance({ nodes: [{ type: "artifact", refId: artifact.id, label: "Final output" }, { type: "tool_call", refId: ctx.toolCallId, label: ctx.toolCallId }], edges: [{ type: "created", fromRef: ctx.toolCallId, toRef: artifact.id }] });
    return { status: "finalized", output: finalText, artifactId: artifact.id, blockingFindingIds: [] };
  }
};

export const taskTool: ToolDefinition<TaskInput, TaskOutput> = {
  id: "task", name: "Task", description: "Delegate bounded work to a subagent running in a child session.", inputSchema: { type: "object", required: ["agentId", "description", "input"], properties: { agentId: stringProp, description: stringProp, input: stringProp, contextArtifactIds: { type: "array", items: stringProp } } }, outputSchema: objectSchema, permission: { kind: "runtime" },
  async execute(ctx, input) {
    const target = ctx.runtime.agentRegistry.get(input.agentId);
    if (!target) throw new RuntimeError("AGENT_NOT_FOUND", input.agentId);
    if (!ctx.runtime.agentRegistry.canRunAs(input.agentId, "subagent")) throw new RuntimeError("AGENT_NOT_SUBAGENT", input.agentId);
    const parent = await ctx.runtime.sessionStore.get(ctx.sessionId);
    if (!parent) throw new RuntimeError("SESSION_NOT_FOUND", ctx.sessionId);
    const child = await ctx.runtime.sessionStore.create({ parentId: parent.id, agentId: input.agentId, input: input.input, cwd: parent.cwd, model: input.model ?? target.model ?? parent.model, title: `${input.description} (@${input.agentId})`, permissions: target.permissions, metadata: { delegatedBy: ctx.agentId, contextArtifactIds: input.contextArtifactIds ?? [] } });
    await ctx.emit({ type: "task.started", parentSessionId: parent.id, childSessionId: child.id, agentId: input.agentId });
    try {
      const result = await new AgentSessionRunner(ctx.runtime).runSession({ sessionId: child.id, mode: "subagent", contextArtifactIds: input.contextArtifactIds ?? [] });
      await ctx.emit({ type: "task.completed", parentSessionId: parent.id, childSessionId: child.id });
      await ctx.recordProvenance({ nodes: [{ type: "session", refId: parent.id, label: `Parent ${parent.id}` }, { type: "session", refId: child.id, label: `Child ${child.id}` }], edges: [{ type: "spawned", fromRef: parent.id, toRef: child.id }] });
      return { childSessionId: child.id, status: result.status, summary: result.output, artifactIds: result.artifactIds };
    } catch (error) {
      await ctx.runtime.sessionStore.update(child.id, { status: "failed" });
      await ctx.emit({ type: "task.failed", parentSessionId: parent.id, childSessionId: child.id, agentId: input.agentId, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
};

export const coreTools = [
  artifactWriteTool,
  artifactReadTool,
  finalizeTool,
  taskTool,
  reviewFindingWriteTool
];
