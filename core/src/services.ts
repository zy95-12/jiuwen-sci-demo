import { RuntimeError } from "./errors.js";
import type {
  AgentDefinition,
  Artifact,
  Message,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  RuntimeEvent,
  Session,
  ToolDefinition
} from "./types.js";

export class DefaultProviderRouter {
  private providers = new Map<string, ModelProvider>();
  register(provider: ModelProvider): void { this.providers.set(provider.id, provider); }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const provider = this.providers.get(request.provider);
    if (!provider) throw new RuntimeError("PROVIDER_NOT_FOUND", request.provider);
    return provider.complete(request);
  }
  list(): string[] { return [...this.providers.keys()]; }
}

export class DefaultPromptAssembler {
  async assemble(input: { session: Session; agent: AgentDefinition; messages: Message[]; availableTools: ToolDefinition[]; contextArtifacts?: Artifact[]; strategyRecord?: unknown }): Promise<ModelMessage[]> {
    const system = [
      input.agent.prompt,
      "You are running inside jiuwen-sci Agent Runtime. Use tools when needed. Do not claim an artifact exists unless it has been created. For delegated work, call the task tool. For final answers, use finalize.",
      `Agent id: ${input.agent.id}`,
      `Available tools:\n${input.availableTools.map((t) => `- ${t.id}: ${t.description}`).join("\n")}`,
      input.contextArtifacts?.length ? `Context artifacts:\n${input.contextArtifacts.map((a) => `- ${a.id} ${a.type} ${a.path}`).join("\n")}` : ""
    ].filter(Boolean).join("\n\n---\n\n");
    return [{ role: "system", content: system }, ...input.messages.map((m) => ({ role: m.role, content: m.content }))];
  }
}

export class DefaultPermissionService {
  async check(): Promise<{ allowed: boolean; reason?: string }> { return { allowed: true }; }
}

export class DefaultEventBus {
  readonly events: RuntimeEvent[] = [];
  constructor(private sink?: (event: RuntimeEvent) => void) {}
  async emit(event: RuntimeEvent): Promise<void> {
    this.events.push(event);
    this.sink?.(event);
  }
}
