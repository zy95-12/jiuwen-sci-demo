import { RuntimeError } from "./errors.js";
import type { AgentDefinition, RunnerResult, RuntimeServices, Session } from "./types.js";
import { ToolRuntime } from "./tool-runtime.js";

export class AgentSessionRunner {
  constructor(private services: RuntimeServices) {}
  async runSession(input: { sessionId: string; mode: "primary" | "subagent"; contextArtifactIds?: string[]; retryContext?: string; revisionContext?: string }): Promise<RunnerResult> {
    const session = await this.requiredSession(input.sessionId);
    const agent = this.requiredAgent(session.agentId);
    await this.services.sessionStore.update(session.id, { status: "running" });
    const prior = await this.services.messageStore.listBySession(session.id);
    if (!prior.some((m) => m.role === "user")) {
      const ctxText = input.contextArtifactIds?.length ? `\n\nContext artifact ids: ${input.contextArtifactIds.join(", ")}` : "";
      await this.services.messageStore.append({ sessionId: session.id, role: "user", content: `${input.revisionContext ? `${session.input}\n\nRevision context:\n${input.revisionContext}` : session.input}${ctxText}` });
    }
    const maxTurns = agent.maxTurns ?? 8;
    const toolRuntime = new ToolRuntime(this.services);
    let output = "";
    let artifactIds = [...session.artifactIds];
    for (let turn = 0; turn < maxTurns; turn++) {
      const current = await this.requiredSession(session.id);
      const messages = await this.services.messageStore.listBySession(session.id);
      const tools = this.services.toolRegistry.listForAgent(agent);
      const modelMessages = await this.services.promptAssembler.assemble({ session: current, agent, messages, availableTools: tools });
      const model = current.model ?? agent.model ?? this.services.config.defaultModel;
      const response = await this.services.providerRouter.complete({ provider: model.provider, model: model.model, messages: modelMessages, tools: tools.map((t) => ({ id: t.id, description: t.description, inputSchema: t.inputSchema })), temperature: agent.temperature });
      await this.services.messageStore.append({ sessionId: session.id, role: "assistant", content: response.content, model, tokenUsage: response.usage });
      if (!response.toolCalls?.length) { output = response.content; break; }
      for (const call of response.toolCalls) {
        const result = await toolRuntime.execute({ sessionId: session.id, agentId: agent.id, toolId: call.toolId, input: call.input });
        await this.services.messageStore.append({ sessionId: session.id, role: "tool", content: summarizeToolOutput(result.output), toolCallId: result.toolCallId });
        artifactIds.push(...extractArtifactIds(result.output));
        if (call.toolId === "finalize") {
          const final = result.output as any;
          if (final.status === "blocked") continue;
          output = String(final.output ?? "");
          await this.services.sessionStore.update(session.id, { status: "completed", artifactIds: [...new Set(artifactIds)] });
          return { sessionId: session.id, status: "completed", output, artifactIds: [...new Set(artifactIds)], reviewFindingIds: [] };
        }
      }
    }
    await this.services.sessionStore.update(session.id, { status: "completed", artifactIds: [...new Set(artifactIds)] });
    return { sessionId: session.id, status: output ? "completed" : "partial", output, artifactIds: [...new Set(artifactIds)], reviewFindingIds: [] };
  }
  private async requiredSession(id: string): Promise<Session> {
    const s = await this.services.sessionStore.get(id);
    if (!s) throw new RuntimeError("SESSION_NOT_FOUND", id);
    return s;
  }
  private requiredAgent(id: string): AgentDefinition {
    const a = this.services.agentRegistry.get(id);
    if (!a) throw new RuntimeError("AGENT_NOT_FOUND", id);
    return a;
  }
}

function summarizeToolOutput(output: unknown): string {
  const text = JSON.stringify(output);
  return text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
}

function extractArtifactIds(output: unknown): string[] {
  if (!output || typeof output !== "object") return [];
  const ids: string[] = [];
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if ("artifactId" in value && typeof (value as any).artifactId === "string") ids.push((value as any).artifactId);
    if ("artifactIds" in value && Array.isArray((value as any).artifactIds)) ids.push(...(value as any).artifactIds.filter((x: unknown) => typeof x === "string"));
  };
  walk(output);
  return ids;
}
