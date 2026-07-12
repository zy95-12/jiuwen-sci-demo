import { existsSync, readFileSync } from "node:fs";
import type { ModelProvider, ModelRequest, ModelResponse } from "./types.js";
import { RuntimeError } from "./errors.js";
import { parseJson } from "./json.js";

export class MockProvider implements ModelProvider {
  id = "mock";
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const sys = request.messages.find((m) => m.role === "system")?.content ?? "";
    const last = [...request.messages].reverse().find((m) => m.role === "user" || m.role === "tool")?.content ?? "";
    if (sys.includes("strategy selection")) {
      const lower = last.toLowerCase();
      const strategy = lower.includes("review") || lower.includes("improve") ? "critic_revise" : "direct";
      return { content: JSON.stringify({ strategy, reason: "Mock deterministic strategy.", confidence: 1, config: { maxRetries: 1, maxReviewRounds: 1 } }) };
    }
    if (last.includes('"status":"finalized"') || last.includes('"status":"blocked"')) return { content: "Done." };
    if (sys.includes("Agent id: reviewer")) {
      return { content: "No blocking findings.", toolCalls: [{ toolId: "finalize", input: { finalText: "Review complete: no blocking findings." } }] };
    }
    if (last.includes("ask a reviewer") || last.includes("critique")) {
      return { content: "Delegating review.", toolCalls: [{ toolId: "task", input: { agentId: "reviewer", description: "Critique answer", input: "Critique this answer." } }] };
    }
    return { content: "Finalizing mock response.", toolCalls: [{ toolId: "finalize", input: { finalText: `Mock response for ${request.model}: ${last.slice(0, 400)}` } }] };
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(readonly id = "openai", private config: { baseUrl?: string; apiKeyEnv?: string; apiKey?: string } = {}) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const apiKey = process.env[this.config.apiKeyEnv ?? "OPENAI_API_KEY"] ?? this.config.apiKey;
    if (!apiKey) throw new RuntimeError("OPENAI_API_KEY_MISSING", this.config.apiKeyEnv ?? "OPENAI_API_KEY");
    const baseUrl = (this.config.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const body: any = { model: normalizeVolcengineModel(request.model, baseUrl), messages: request.messages.map((m) => ({ role: m.role === "tool" ? "user" : m.role, content: m.content })), temperature: request.temperature ?? 0, max_tokens: request.maxTokens ?? 4096 };
    if (request.tools?.length) body.tools = (request.tools as any[]).map((t) => ({ type: "function", function: { name: t.id, description: t.description, parameters: t.inputSchema ?? { type: "object" } } }));
    const res = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) });
    if (!res.ok) throw new RuntimeError("OPENAI_COMPATIBLE_ERROR", `${res.status} ${await res.text()}`);
    const json = await res.json() as any;
    const msg = json.choices?.[0]?.message ?? {};
    const toolCalls = (msg.tool_calls ?? []).map((c: any) => ({ id: c.id, toolId: c.function?.name, input: parseJson(c.function?.arguments, {}) }));
    return { content: msg.content ?? "", toolCalls, usage: json.usage ? { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens, totalTokens: json.usage.total_tokens } : undefined };
  }
}

export function readArkHelperApiKey(): string | undefined {
  const file = "/root/.ark-helper/config.yaml";
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8");
  const match = text.match(/^\s*api_key\s*:\s*(.+?)\s*$/m);
  return match?.[1]?.trim().replace(/^["']|["']$/g, "");
}

function normalizeVolcengineModel(model: string, baseUrl: string): string {
  if (baseUrl.includes("/api/coding/") || baseUrl.includes("/api/plan/")) return model;
  const aliases: Record<string, string> = {
    "glm-5.2": "glm-5-2-260617",
    "glm5.2": "glm-5-2-260617",
    "glm-5-2": "glm-5-2-260617"
  };
  return aliases[model] ?? model;
}
