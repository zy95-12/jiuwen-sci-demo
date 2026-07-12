import { createInternalToolContext } from "./contexts.js";
import { taskTool } from "./core-tools.js";
import { RuntimeError } from "./errors.js";
import { countMatchingArtifacts, createArtifactManifest, decideGateAction, effectiveGate, formatVerifierFeedback, renderStageAgentPrompt, resolveStageTransition } from "./stage-helpers.js";
import { ToolRuntime } from "./tool-runtime.js";
import type {
  Artifact,
  ReviewFinding,
  RunnerResult,
  RuntimeServices,
  RuntimeStatus,
  StageContractDefinition,
  StageExecutionResult,
  StageGateDecisionRule,
  StageSpec,
  StageVerifierResult,
  TaskOutput
} from "./types.js";

export class StageContractRunner {
  constructor(private services: RuntimeServices) {}
  async run(input: { sessionId: string; contractId: string; userGoal: string; metadata?: Record<string, unknown> }): Promise<RunnerResult> {
    const contract = this.services.packRegistry.getStageContract(input.contractId);
    if (!contract) throw new RuntimeError("STAGE_CONTRACT_NOT_FOUND", input.contractId);
    const stageById = new Map(contract.stages.map((stage) => [stage.id, stage]));
    let currentId: string | undefined = contract.initialStageId;
    let status: RuntimeStatus = "completed";
    let output = "";
    let artifactIds: string[] = [];
    let reviewFindingIds: string[] = [];
    const state: Record<string, unknown> = {};
    const maxStages = contract.maxStages ?? Math.max(20, contract.stages.length * 3);
    await this.services.sessionStore.update(input.sessionId, { status: "running" });

    for (let step = 0; currentId && step < maxStages; step++) {
      const stage = stageById.get(currentId);
      if (!stage) throw new RuntimeError("STAGE_NOT_FOUND", currentId);
      await this.services.eventBus.emit({ type: "stage.started", sessionId: input.sessionId, contractId: contract.id, stageId: stage.id });
      const attempts = Math.max(1, stage.retryPolicy?.maxAttempts ?? 1);
      let passed = false;
      let terminalAction: "partial" | "fail" | undefined;
      let lastResult: StageExecutionResult = {};

      for (let attempt = 1; attempt <= attempts; attempt++) {
        const feedback = (state[`stage.${stage.id}.feedback`] as string[] | undefined) ?? [];
        lastResult = await this.runStage({ contract, stage, sessionId: input.sessionId, userGoal: input.userGoal, metadata: input.metadata ?? {}, artifactIds, state, attempt, feedback });
        artifactIds = [...new Set([...artifactIds, ...(lastResult.artifactIds ?? [])])];
        Object.assign(state, lastResult.statePatch ?? {});
        output = lastResult.output ?? output;

        const gate = await this.evaluateGate(contract, stage, input.sessionId, artifactIds, state, attempt);
        artifactIds = [...new Set([...artifactIds, gate.reportArtifactId])];
        reviewFindingIds.push(...gate.findingIds);
        if (gate.action === "next" || gate.action === "continue" || gate.action === "go_to_stage") {
          passed = true;
          if (gate.action === "go_to_stage") lastResult.nextStageId = gate.nextStageId;
          await this.services.eventBus.emit({ type: gate.action === "go_to_stage" ? "stage.redirected" : "stage.completed", sessionId: input.sessionId, contractId: contract.id, stageId: stage.id, attempt, nextStageId: gate.nextStageId });
          break;
        }
        if (gate.action === "partial" || gate.action === "fail") terminalAction = gate.action;

        await this.services.eventBus.emit({ type: "stage.failed", sessionId: input.sessionId, contractId: contract.id, stageId: stage.id, attempt, messages: gate.messages, action: gate.action });
        state[`stage.${stage.id}.feedback`] = gate.messages;
        if (gate.action !== "retry_stage") break;
      }

      if (!passed && stage.retryPolicy?.onFailure !== "continue") {
        status = terminalAction === "fail" ? "failed" : "partial";
        break;
      }
      currentId = lastResult.nextStageId ?? resolveStageTransition(stage, passed);
    }

    if (currentId) status = "partial";
    const findings = await this.services.reviewStore.listBySessionTree(input.sessionId);
    reviewFindingIds = [...new Set([...reviewFindingIds, ...findings.map((f) => f.id)])];
    await this.services.sessionStore.update(input.sessionId, { status: status === "completed" ? "completed" : status, artifactIds: [...new Set(artifactIds)] });
    return { sessionId: input.sessionId, status, output, artifactIds: [...new Set(artifactIds)], reviewFindingIds };
  }

  private async runStage(input: { contract: StageContractDefinition; stage: StageSpec; sessionId: string; userGoal: string; metadata: Record<string, unknown>; artifactIds: string[]; state: Record<string, unknown>; attempt: number; feedback: string[] }): Promise<StageExecutionResult> {
    const { contract, stage, sessionId, userGoal, metadata, state } = input;
    let artifactIds = input.artifactIds;
    let agentTask: TaskOutput | undefined;
    if (stage.agentId) {
      const manifest = await createArtifactManifest(this.services, artifactIds);
      if (!this.services.agentRegistry.get(stage.agentId)) {
        await this.recordStageAgentFailure({ sessionId, contract, stage, state, feedback: input.feedback, message: `AGENT_NOT_FOUND: ${stage.agentId}` });
      } else {
      try {
        agentTask = await taskTool.execute(createInternalToolContext(this.services, sessionId, "stage-runner"), {
          agentId: stage.agentId,
          description: `Stage ${stage.id}`,
          input: renderStageAgentPrompt({ contract, stage, userGoal, attempt: input.attempt, feedback: input.feedback, artifactManifest: manifest }),
          contextArtifactIds: artifactIds
        });
        artifactIds = [...new Set([...artifactIds, ...agentTask.artifactIds])];
        state[`stage.${stage.id}.agentTask`] = agentTask;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.recordStageAgentFailure({ sessionId, contract, stage, state, feedback: input.feedback, message });
      }
      }
    }
    if (!stage.run) return { artifactIds: agentTask?.artifactIds ?? [], statePatch: agentTask ? { [`stage.${stage.id}.agentTask`]: agentTask } : undefined };
    const toolRuntime = new ToolRuntime(this.services);
    const result = await stage.run({
      sessionId,
      services: this.services,
      contract,
      stage,
      attempt: input.attempt,
      feedback: input.feedback,
      agentTask,
      input: userGoal,
      metadata,
      artifactIds,
      state,
      task: (taskInput) => taskTool.execute(createInternalToolContext(this.services, sessionId, "stage-runner"), taskInput),
      tool: (toolInput) => toolRuntime.execute({ sessionId, agentId: stage.agentId ?? "stage-runner", toolId: toolInput.toolId, input: toolInput.input, allowedToolIds: stage.allowedTools }),
      createArtifact: (artifactInput) => this.services.artifactStore.create({ ...artifactInput, sessionId, createdBy: { sessionId, agentId: stage.agentId ?? "stage-runner", toolId: "stage" } }),
      recordProvenance: (prov) => this.services.provenanceStore.record(prov)
    });
    return {
      ...result,
      artifactIds: [...new Set([...(agentTask?.artifactIds ?? []), ...(result.artifactIds ?? [])])],
      statePatch: { ...(agentTask ? { [`stage.${stage.id}.agentTask`]: agentTask } : {}), ...(result.statePatch ?? {}) }
    };
  }

  private async recordStageAgentFailure(input: { sessionId: string; contract: StageContractDefinition; stage: StageSpec; state: Record<string, unknown>; feedback: string[]; message: string }): Promise<void> {
    input.state[`stage.${input.stage.id}.agentError`] = input.message;
    input.state[`stage.${input.stage.id}.feedback`] = [...input.feedback, `Stage agent failed before producing valid artifacts: ${input.message}`];
    await this.services.reviewStore.create({
      sessionId: input.sessionId,
      severity: "major",
      category: "stage_agent_failed",
      targetType: "stage",
      targetRef: input.stage.id,
      description: `Stage agent failed before scaffold fallback: ${input.message}`,
      suggestedAction: "Use scaffold fallback for this attempt and tighten the stage agent tool arguments."
    });
    await this.services.eventBus.emit({ type: "stage.agent_failed", sessionId: input.sessionId, contractId: input.contract.id, stageId: input.stage.id, error: input.message });
  }

  private async evaluateGate(contract: StageContractDefinition, stage: StageSpec, sessionId: string, artifactIds: string[], state: Record<string, unknown>, attempt: number): Promise<{ action: StageGateDecisionRule["action"]; nextStageId?: string; messages: string[]; findingIds: string[]; reportArtifactId: string }> {
    const messages: string[] = [];
    const findingIds: string[] = [];
    const deterministicResults: (StageVerifierResult & { verifierId: string; hardGate: boolean })[] = [];
    const semanticFindings: ReviewFinding[] = [];
    const gate = effectiveGate(stage);

    for (const req of stage.requiredArtifacts ?? []) {
      const count = await countMatchingArtifacts(this.services, artifactIds, req);
      const minCount = req.minCount ?? (req.required === false ? 0 : 1);
      if (count < minCount) {
        const result = { verifierId: "required_artifact", hardGate: true, ok: false, message: `Missing required artifact for stage ${stage.id}: ${JSON.stringify(req)}`, severity: "blocking" as const, category: "missing_artifact" };
        deterministicResults.push(result);
        messages.push(formatVerifierFeedback(result));
      }
    }

    for (const policy of gate.deterministic ?? []) {
      const verifier = this.services.verifierRegistry.get(policy.id);
      if (!verifier) throw new RuntimeError("VERIFIER_NOT_FOUND", policy.id);
      const result = await verifier.verify({ sessionId, services: this.services, contract, stage, artifactIds, state });
      deterministicResults.push({ ...result, verifierId: policy.id, hardGate: policy.hardGate === true });
      if (!result.ok) {
        messages.push(formatVerifierFeedback({ ...result, verifierId: policy.id, hardGate: policy.hardGate === true }));
        const severity = result.severity ?? "major";
        const finding = await this.services.reviewStore.create({
          sessionId,
          severity,
          category: result.category ?? `verifier:${policy.id}`,
          targetType: "stage",
          targetRef: result.targetRef ?? stage.id,
          description: result.message,
          suggestedAction: "Revise the stage output and rerun verification."
        });
        findingIds.push(finding.id);
      }
    }

    const report = await this.writeVerifierReport({ sessionId, contract, stage, attempt, deterministicResults, messages, state });
    const artifactIdsWithReport = [...new Set([...artifactIds, report.id])];
    const artifactManifest = await createArtifactManifest(this.services, artifactIdsWithReport);
    const deterministicOk = deterministicResults.every((result) => result.ok);
    const hardGateFailed = deterministicResults.some((result) => !result.ok && result.hardGate);
    const reviewPolicy = gate.semantic;
    const existingStageFindings = (await this.services.reviewStore.listBySession(sessionId)).filter((finding) => finding.targetType === "stage" && finding.targetRef === stage.id && finding.status === "open" && ["stage_agent_failed", "stage_review_failed"].includes(finding.category));
    const existingReviewFailures = existingStageFindings.filter((finding) => finding.category === "stage_review_failed");
    semanticFindings.push(...existingStageFindings.filter((finding) => finding.category !== "stage_review_failed"));

    if (reviewPolicy?.mode === "always" || (reviewPolicy?.mode === "on_failure" && !deterministicOk)) {
      if (reviewPolicy.reviewerId) {
        const reviewer = this.services.reviewerRegistry.get(reviewPolicy.reviewerId);
        if (!reviewer) throw new RuntimeError("REVIEWER_NOT_FOUND", reviewPolicy.reviewerId);
        const review = await reviewer.review({ sessionId, artifactIds: artifactIdsWithReport, services: this.services });
        findingIds.push(...review.findingIds);
        semanticFindings.push(...(await this.services.reviewStore.listBySession(sessionId)).filter((finding) => review.findingIds.includes(finding.id)));
      } else if (reviewPolicy.agentId) {
        try {
          const review = await taskTool.execute(createInternalToolContext(this.services, sessionId, "stage-runner"), {
            agentId: reviewPolicy.agentId,
            description: `Review stage ${stage.id}`,
            input: `Review stage "${stage.id}" for semantic quality and blocking issues. Use the verifier_report artifact to avoid repeating deterministic checks and focus on semantic risks.\n\nArtifact manifest:\n${JSON.stringify(artifactManifest, null, 2)}\n\nDo not call artifact_read unless artifactId is copied exactly from this manifest.`,
            contextArtifactIds: artifactIdsWithReport
          });
          const childFindings = await this.services.reviewStore.listBySession(review.childSessionId);
          if (existingReviewFailures.length) await this.services.reviewStore.resolve(existingReviewFailures.map((finding) => finding.id));
          semanticFindings.push(...childFindings);
          findingIds.push(...childFindings.map((f) => f.id));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const finding = await this.services.reviewStore.create({
            sessionId,
            severity: "major",
            category: "stage_review_failed",
            targetType: "stage",
            targetRef: stage.id,
            description: `Stage review agent failed; continuing with deterministic gate only: ${message}`,
            suggestedAction: "Tighten reviewer prompt/tool arguments and rerun semantic review."
          });
          findingIds.push(finding.id);
          semanticFindings.push(finding);
          messages.push(finding.description);
          await this.services.eventBus.emit({ type: "stage.review_failed", sessionId, contractId: contract.id, stageId: stage.id, error: message });
        }
      }
    } else {
      semanticFindings.push(...existingReviewFailures);
    }

    const reviewBlocking = semanticFindings.some((finding) => finding.severity === "blocking" && finding.status === "open");
    const reviewMajor = semanticFindings.some((finding) => ["high", "major"].includes(finding.severity) && finding.status === "open");
    const action = decideGateAction({ stage, deterministicOk, hardGateFailed, reviewBlocking, reviewMajor, deterministicResults, semanticFindings });
    return { ...action, messages: [...messages, ...semanticFindings.map((finding) => finding.description)], findingIds, reportArtifactId: report.id };
  }

  private async writeVerifierReport(input: { sessionId: string; contract: StageContractDefinition; stage: StageSpec; attempt: number; deterministicResults: (StageVerifierResult & { verifierId: string; hardGate: boolean })[]; messages: string[]; state: Record<string, unknown> }): Promise<Artifact> {
    const content = {
      stage: "verifier_report",
      contractId: input.contract.id,
      stageId: input.stage.id,
      attempt: input.attempt,
      deterministicChecks: input.deterministicResults.map((result) => ({
        verifierId: result.verifierId,
        hardGate: result.hardGate,
        ok: result.ok,
        severity: result.severity,
        category: result.category,
        targetRef: result.targetRef,
        message: result.message,
        diagnostics: result.diagnostics
      })),
      messages: input.messages
    };
    const artifact = await this.services.artifactStore.create({ sessionId: input.sessionId, type: "json", mediaType: "application/json", content: JSON.stringify(content, null, 2), createdBy: { sessionId: input.sessionId, agentId: "stage-runner", toolId: "verifier" } });
    input.state[`stage.${input.stage.id}.verifierReportArtifactId`] = artifact.id;
    return artifact;
  }
}
