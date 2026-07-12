import { AgentSessionRunner } from "./agent-session-runner.js";
import { createInternalToolContext, createWorkflowContext } from "./contexts.js";
import { taskTool } from "./core-tools.js";
import { RuntimeError } from "./errors.js";
import type { ExecutionDecision, ModelRef, PackWorkflowDecision, RunnerResult, RuntimeRunResult, RuntimeServices, Strategy } from "./types.js";

export class StrategySelector {
  constructor(private services: RuntimeServices) {}
  async select(input: { agentId: string; userGoal: string; requestedStrategy?: Strategy | "auto"; model?: ModelRef }): Promise<ExecutionDecision> {
    if (input.requestedStrategy && input.requestedStrategy !== "auto") return { strategy: input.requestedStrategy, reason: "User explicitly requested this strategy.", confidence: 1 };
    const agent = this.services.agentRegistry.get(input.agentId);
    if (!agent?.supportsStrategySelection) return { strategy: "direct", reason: "Agent does not support strategy selection.", confidence: 1 };
    const model = input.model ?? agent.model ?? this.services.config.defaultModel;
    const response = await this.services.providerRouter.complete({ provider: model.provider, model: model.model, messages: [{ role: "system", content: "strategy selection: choose direct, retry, critic_revise, workflow_controlled. Return JSON only." }, { role: "user", content: input.userGoal }], temperature: 0, maxTokens: 800 });
    try {
      return JSON.parse(response.content) as ExecutionDecision;
    } catch {
      return { strategy: "direct", reason: "Strategy response was not JSON.", confidence: 0.5 };
    }
  }
}

export class PackWorkflowSelector {
  constructor(private services: RuntimeServices) {}
  async select(input: { userGoal: string; model?: ModelRef; allowedPackIds?: string[] }): Promise<PackWorkflowDecision> {
    const catalog = this.services.packRegistry.workflowCatalog()
      .filter((entry) => !input.allowedPackIds?.length || input.allowedPackIds.includes(entry.packId));
    if (catalog.length === 0) return { reason: "No registered pack workflows.", confidence: 1 };

    const heuristic = this.heuristic(input.userGoal, catalog);
    if (heuristic.confidence >= 0.9 || (input.model?.provider ?? this.services.config.defaultModel.provider) === "mock") return heuristic;

    const model = input.model ?? this.services.config.defaultModel;
    const response = await this.services.providerRouter.complete({
      provider: model.provider,
      model: model.model,
      messages: [
        {
          role: "system",
          content: [
            "You route a user goal to one registered jiuwen-sci capability-pack workflow.",
            "Choose a workflow only when the goal clearly matches it; otherwise return no workflowId.",
            "Return JSON only: {\"workflowId\":\"optional\", \"packId\":\"optional\", \"reason\":\"...\", \"confidence\":0.0}.",
            `Available workflows:\n${catalog.map((w) => `- ${w.workflowId} (pack ${w.packId}): ${w.description}`).join("\n")}`
          ].join("\n")
        },
        { role: "user", content: input.userGoal }
      ],
      temperature: 0,
      maxTokens: 600
    });
    try {
      const decision = JSON.parse(response.content) as PackWorkflowDecision;
      if (decision.workflowId && catalog.some((w) => w.workflowId === decision.workflowId)) return decision;
    } catch {
      // Fall through to deterministic routing.
    }
    return heuristic;
  }
  private heuristic(goal: string, catalog: { packId: string; workflowId: string }[]): PackWorkflowDecision {
    const lower = goal.toLowerCase();
    const wantsLiterature = [
      "literature", "paper", "papers", "survey", "review", "prisma", "citation", "doi",
      "文献", "论文", "综述", "调研", "引用", "检索"
    ].some((term) => lower.includes(term));
    const literature = catalog.find((w) => w.workflowId === "literature-review");
    if (wantsLiterature && literature) return { workflowId: literature.workflowId, packId: literature.packId, reason: "Goal matches literature-review workflow keywords.", confidence: 0.95 };
    return { reason: "No registered workflow clearly matches the goal.", confidence: 0.7 };
  }
}

export class DefaultStrategyGuard {
  constructor(private services: RuntimeServices) {}
  async validate(input: { decision: ExecutionDecision }): Promise<{ allowed: boolean; finalDecision: ExecutionDecision; warnings: string[]; reason?: string }> {
    const supported = new Set(["direct", "retry", "critic_revise", "workflow_controlled"]);
    const finalDecision = structuredClone(input.decision);
    const warnings: string[] = [];
    if (!supported.has(finalDecision.strategy)) {
      warnings.push(`Strategy ${finalDecision.strategy} is not supported in v0.1. Downgraded to direct.`);
      finalDecision.strategy = "direct";
    }
    if (finalDecision.strategy === "retry" && Number(finalDecision.config?.maxRetries ?? 1) > this.services.config.limits.maxRetries) {
      finalDecision.config = { ...finalDecision.config, maxRetries: this.services.config.limits.maxRetries };
      warnings.push("Reduced maxRetries to runtime limit.");
    }
    return { allowed: true, finalDecision, warnings };
  }
}

export class ExecutionEngine {
  private runners = new Map<string, ExecutionRunner>();
  constructor(private services: RuntimeServices, private selector: StrategySelector, private guard: DefaultStrategyGuard) {}
  registerRunner(runner: ExecutionRunner): void { this.runners.set(runner.strategy, runner); }
  async run(input: { sessionId: string; input: string; requestedStrategy?: Strategy | "auto" }): Promise<RuntimeRunResult> {
    const session = await this.services.sessionStore.get(input.sessionId);
    if (!session) throw new RuntimeError("SESSION_NOT_FOUND", input.sessionId);
    const decision = await this.selector.select({ agentId: session.agentId, userGoal: input.input, requestedStrategy: input.requestedStrategy, model: session.model });
    const guard = await this.guard.validate({ decision });
    const rec = await this.services.storage.strategyRecords.create({ sessionId: session.id, userRequestedStrategy: input.requestedStrategy, agentDecision: decision, guardResult: guard, finalStrategy: guard.finalDecision.strategy });
    await this.services.sessionStore.update(session.id, { strategyRecordId: rec.id });
    await this.services.eventBus.emit({ type: "strategy.selected", sessionId: session.id, strategy: guard.finalDecision.strategy });
    const runner = this.runners.get(guard.finalDecision.strategy);
    if (!runner) throw new RuntimeError("RUNNER_NOT_FOUND", guard.finalDecision.strategy);
    return runner.run({ sessionId: session.id, userGoal: input.input, decision: guard.finalDecision });
  }
  async resume(input: { sessionId: string }): Promise<RuntimeRunResult> {
    const session = await this.services.sessionStore.get(input.sessionId);
    if (!session) throw new RuntimeError("SESSION_NOT_FOUND", input.sessionId);
    const rec = session.strategyRecordId ? await this.services.storage.strategyRecords.get(session.strategyRecordId) : null;
    const strategy = rec?.finalStrategy ?? "direct";
    const runner = this.runners.get(strategy);
    if (!runner) throw new RuntimeError("RUNNER_NOT_FOUND", strategy);
    return runner.run({ sessionId: session.id, userGoal: session.input, decision: rec?.agentDecision ?? { strategy, reason: "Resumed existing session.", confidence: 1 } });
  }
}

export type ExecutionRunner = { strategy: Strategy; run(input: { sessionId: string; userGoal: string; decision: ExecutionDecision }): Promise<RunnerResult> };

export class DirectRunner implements ExecutionRunner {
  strategy: Strategy = "direct";
  constructor(private services: RuntimeServices) {}
  run(input: { sessionId: string }): Promise<RunnerResult> { return new AgentSessionRunner(this.services).runSession({ sessionId: input.sessionId, mode: "primary" }); }
}

export class RetryRunner implements ExecutionRunner {
  strategy: Strategy = "retry";
  constructor(private services: RuntimeServices) {}
  async run(input: { sessionId: string; decision: ExecutionDecision }): Promise<RunnerResult> {
    const max = Number(input.decision.config?.maxRetries ?? 2);
    let last: unknown;
    for (let i = 0; i <= max; i++) {
      try { return await new AgentSessionRunner(this.services).runSession({ sessionId: input.sessionId, mode: "primary", retryContext: i ? String(last) : undefined }); } catch (e) { last = e; }
    }
    throw last;
  }
}

export class CriticReviseRunner implements ExecutionRunner {
  strategy: Strategy = "critic_revise";
  constructor(private services: RuntimeServices) {}
  async run(input: { sessionId: string; decision: ExecutionDecision }): Promise<RunnerResult> {
    let result = await new AgentSessionRunner(this.services).runSession({ sessionId: input.sessionId, mode: "primary" });
    const max = Number(input.decision.config?.maxReviewRounds ?? 1);
    for (let i = 0; i < max; i++) {
      const ctx = createInternalToolContext(this.services, input.sessionId, "system");
      const review = await taskTool.execute(ctx, { agentId: "reviewer", description: "Review current output", input: "Review current artifacts and report blocking issues only for serious defects.", contextArtifactIds: result.artifactIds });
      const findings = await this.services.reviewStore.listBySession(review.childSessionId);
      if (!findings.some((f) => f.severity === "blocking" && f.status === "open")) return { ...result, reviewFindingIds: findings.map((f) => f.id) };
      result = await new AgentSessionRunner(this.services).runSession({ sessionId: input.sessionId, mode: "primary", revisionContext: review.summary });
    }
    return { ...result, status: "partial" };
  }
}

export class WorkflowRunner implements ExecutionRunner {
  strategy: Strategy = "workflow_controlled";
  constructor(private services: RuntimeServices) {}
  async run(input: { sessionId: string; userGoal: string; decision: ExecutionDecision }): Promise<RunnerResult> {
    const session = await this.services.sessionStore.get(input.sessionId);
    const workflowId = String(input.decision.config?.workflowId ?? session?.metadata.workflow ?? "");
    if (!workflowId) throw new RuntimeError("WORKFLOW_NOT_SPECIFIED", "workflow_controlled requires session.metadata.workflow or decision.config.workflowId");
    const workflow = this.services.packRegistry.getWorkflow(workflowId);
    if (!workflow) throw new RuntimeError("WORKFLOW_NOT_FOUND", workflowId);
    const ctx = createWorkflowContext(this.services, input.sessionId, taskTool);
    await this.services.sessionStore.update(input.sessionId, { status: "running" });
    const result = await workflow.run(ctx, { input: input.userGoal, metadata: session?.metadata });
    await this.services.sessionStore.update(input.sessionId, { status: result.status === "completed" ? "completed" : result.status, artifactIds: result.artifactIds });
    return result;
  }
}
