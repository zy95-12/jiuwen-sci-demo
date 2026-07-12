import { RuntimeError } from "./errors.js";
import type { RuntimeServices, ToolContext, ToolDefinition } from "./types.js";

export class ToolRuntime {
  constructor(private services: RuntimeServices) {}
  async execute(input: { sessionId: string; agentId: string; toolId: string; input: unknown; allowedToolIds?: string[] }): Promise<{ toolCallId: string; output: unknown }> {
    if (input.allowedToolIds && !input.allowedToolIds.includes(input.toolId)) throw new RuntimeError("TOOL_NOT_ALLOWED_IN_STAGE", input.toolId);
    const tool = this.services.toolRegistry.get(input.toolId);
    if (!tool) throw new RuntimeError("TOOL_NOT_FOUND", input.toolId);
    validateToolInput(tool, input.input);
    const perm = await this.services.permissionService.check();
    if (!perm.allowed) throw new RuntimeError("TOOL_PERMISSION_DENIED", perm.reason ?? input.toolId);
    const call = await this.services.toolCallStore.create({ sessionId: input.sessionId, toolId: input.toolId, inputJson: input.input, status: "running" });
    await this.services.eventBus.emit({ type: "tool.started", sessionId: input.sessionId, agentId: input.agentId, toolId: input.toolId, input: summarizeForEvent(input.input) });
    try {
      const ctx: ToolContext = {
        runtime: this.services, sessionId: input.sessionId, agentId: input.agentId, toolCallId: call.id,
        emit: (event) => this.services.eventBus.emit(event),
        createArtifact: (artifactInput) => this.services.artifactStore.create({ ...artifactInput, sessionId: input.sessionId, createdBy: { sessionId: input.sessionId, agentId: input.agentId, toolId: input.toolId } }),
        recordProvenance: (prov) => this.services.provenanceStore.record(prov)
      };
      const output = await tool.execute(ctx, input.input as never);
      await this.services.toolCallStore.complete(call.id, output);
      await this.services.eventBus.emit({ type: "tool.completed", sessionId: input.sessionId, agentId: input.agentId, toolId: input.toolId, output: summarizeForEvent(output) });
      return { toolCallId: call.id, output };
    } catch (error) {
      await this.services.toolCallStore.fail(call.id, error instanceof Error ? { message: error.message } : error);
      throw error;
    }
  }
}

function summarizeForEvent(value: unknown): unknown {
  if (Array.isArray(value)) return value.length > 5 ? { count: value.length, sample: value.slice(0, 5).map(summarizeForEvent) } : value.map(summarizeForEvent);
  if (!value || typeof value !== "object") return typeof value === "string" && value.length > 300 ? `${value.slice(0, 300)}...` : value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (["content", "finalText", "output", "answer", "text"].includes(key) && typeof raw === "string") {
      out[key] = raw.length > 300 ? `${raw.slice(0, 300)}...` : raw;
    } else if (Array.isArray(raw)) {
      out[key] = raw.length > 5 ? { count: raw.length, sample: raw.slice(0, 5).map(summarizeForEvent) } : raw.map(summarizeForEvent);
    } else if (raw && typeof raw === "object") {
      out[key] = summarizeForEvent(raw);
    } else {
      out[key] = raw;
    }
  }
  return out;
}

function validateToolInput(tool: ToolDefinition, input: unknown): void {
  const schema = tool.inputSchema ?? {};
  if ((schema as any).type !== "object") return;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RuntimeError("TOOL_INPUT_INVALID", `${tool.id}: input must be an object`);
  const obj = input as Record<string, unknown>;
  for (const key of ((schema as any).required ?? [])) {
    const value = obj[key];
    if (value === undefined || value === null || value === "") throw new RuntimeError("TOOL_INPUT_INVALID", `${tool.id}.${key} is required`);
  }
  const props = ((schema as any).properties ?? {}) as Record<string, any>;
  for (const [key, prop] of Object.entries(props)) {
    if (!(key in obj) || obj[key] === undefined || obj[key] === null) continue;
    const value = obj[key];
    if (prop.type === "string" && typeof value !== "string") throw new RuntimeError("TOOL_INPUT_INVALID", `${tool.id}.${key} must be a string`);
    if (prop.type === "number" && typeof value !== "number") throw new RuntimeError("TOOL_INPUT_INVALID", `${tool.id}.${key} must be a number`);
    if (prop.type === "integer" && (!Number.isInteger(value))) throw new RuntimeError("TOOL_INPUT_INVALID", `${tool.id}.${key} must be an integer`);
    if (prop.type === "boolean" && typeof value !== "boolean") throw new RuntimeError("TOOL_INPUT_INVALID", `${tool.id}.${key} must be a boolean`);
    if (prop.type === "array" && !Array.isArray(value)) throw new RuntimeError("TOOL_INPUT_INVALID", `${tool.id}.${key} must be an array`);
    if (prop.minLength && typeof value === "string" && value.trim().length < Number(prop.minLength)) throw new RuntimeError("TOOL_INPUT_INVALID", `${tool.id}.${key} must not be empty`);
  }
}
