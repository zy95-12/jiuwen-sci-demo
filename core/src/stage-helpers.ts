import type {
  ArtifactRequirement,
  ReviewFinding,
  RuntimeServices,
  StageGateDecisionRule,
  StageGatePolicy,
  StageSpec,
  StageVerifierResult,
  StageContractDefinition
} from "./types.js";

export function resolveStageTransition(stage: StageSpec, passed: boolean): string | undefined {
  const desired = passed ? "passed" : "failed";
  return stage.next?.find((t) => t.when === desired)?.stageId ?? stage.next?.find((t) => t.when === "always")?.stageId;
}

export function effectiveGate(stage: StageSpec): StageGatePolicy {
  return {
    deterministic: stage.gate?.deterministic ?? stage.verifiers?.map((id) => ({ id, hardGate: false })) ?? [],
    semantic: stage.gate?.semantic ?? stage.review,
    rules: stage.gate?.rules ?? defaultGateRules(stage)
  };
}

export function defaultGateRules(stage: StageSpec): StageGateDecisionRule[] {
  const retryAction = stage.retryPolicy?.onFailure === "continue" ? "continue" : stage.retryPolicy?.onFailure === "fail" ? "partial" : "retry_stage";
  return [
    { when: "hard_gate_failed", action: retryAction },
    { when: "review_blocking", action: retryAction },
    { when: "review_major", action: retryAction },
    { when: "verifier_failed", action: retryAction },
    { when: "passed", action: "next" }
  ];
}

export function decideGateAction(input: { stage: StageSpec; deterministicOk: boolean; hardGateFailed: boolean; reviewBlocking: boolean; reviewMajor: boolean; deterministicResults: (StageVerifierResult & { verifierId: string; hardGate: boolean })[]; semanticFindings: ReviewFinding[] }): { action: StageGateDecisionRule["action"]; nextStageId?: string } {
  const gate = effectiveGate(input.stage);
  const signals = gateSignals(input);
  const rule = gate.rules?.find((candidate) => signals.some((signal) => gateRuleMatches(candidate.when, signal))) ?? { when: input.deterministicOk ? "passed" : "failed", action: input.deterministicOk ? "next" : "retry_stage" };
  return { action: rule.action, nextStageId: rule.stageId };
}

export function gateSignals(input: { deterministicOk: boolean; hardGateFailed: boolean; reviewBlocking: boolean; reviewMajor: boolean; deterministicResults: (StageVerifierResult & { verifierId: string; hardGate: boolean })[]; semanticFindings: ReviewFinding[] }): string[] {
  const signals: string[] = [];
  if (input.deterministicOk && !input.reviewBlocking && !input.reviewMajor) signals.push("passed");
  if (!input.deterministicOk || input.reviewBlocking || input.reviewMajor) signals.push("failed");
  if (input.hardGateFailed) signals.push("hard_gate_failed");
  for (const result of input.deterministicResults.filter((result) => !result.ok)) {
    signals.push("verifier_failed");
    signals.push(`verifier_failed:${result.verifierId}`);
    if (result.category) signals.push(`verifier_failed:${result.category}`);
  }
  if (input.reviewBlocking) signals.push("review_blocking");
  if (input.reviewMajor) signals.push("review_major");
  for (const finding of input.semanticFindings.filter((finding) => finding.status === "open")) {
    signals.push(`review_${finding.severity}`);
    signals.push(`review_${finding.severity}:${finding.category}`);
    signals.push(finding.category);
  }
  return signals;
}

export function gateRuleMatches(ruleWhen: string, signal: string): boolean {
  return ruleWhen === signal || (ruleWhen.endsWith(":*") && signal.startsWith(ruleWhen.slice(0, -1)));
}

export function renderStageAgentPrompt(input: { contract: StageContractDefinition; stage: StageSpec; userGoal: string; attempt: number; feedback: string[]; artifactManifest: unknown }): string {
  const required = input.stage.requiredArtifacts?.length
    ? input.stage.requiredArtifacts.map((req) => `- ${JSON.stringify(req)}`).join("\n")
    : "- No required artifacts declared.";
  const gate = effectiveGate(input.stage);
  const verifiers = gate.deterministic?.length ? gate.deterministic.map((policy) => `- ${policy.id}${policy.hardGate ? " (hard gate)" : ""}`).join("\n") : "- No verifiers declared.";
  const allowedTools = input.stage.allowedTools?.length ? input.stage.allowedTools.join(", ") : "all registered tools";
  const feedback = input.feedback.length ? `\nPrevious verifier/review feedback to fix:\n${input.feedback.map((m) => `- ${m}`).join("\n")}\n` : "";
  return [
    `Run stage "${input.stage.id}" for contract "${input.contract.id}".`,
    `Goal: ${input.stage.goal}`,
    input.stage.instructions ? `Stage-specific output contract:\n${input.stage.instructions}` : "",
    `User goal:\n${input.userGoal}`,
    `Attempt: ${input.attempt}`,
    `Allowed tools: ${allowedTools}`,
    `Required input roles: ${(input.stage.requiredInputs ?? []).join(", ") || "none declared"}`,
    `Required artifacts:\n${required}`,
    `Verifiers that will judge completion:\n${verifiers}`,
    `Artifact manifest:\n${JSON.stringify(input.artifactManifest, null, 2)}`,
    feedback,
    "Produce the required structured artifacts with artifact_write before finalizing. For JSON artifacts, call artifact_write with type=\"json\", mediaType=\"application/json\", and content equal to a JSON string that includes the declared stage field exactly. Example: artifact_write({\"type\":\"json\",\"mediaType\":\"application/json\",\"content\":\"{\\\"stage\\\":\\\"protocol\\\",\\\"question\\\":\\\"...\\\"}\"}). If reading an artifact, copy artifactId exactly from the manifest; never call artifact_read with an empty or invented artifactId."
  ].filter(Boolean).join("\n\n");
}

export function formatVerifierFeedback(result: StageVerifierResult & { verifierId: string; hardGate?: boolean }): string {
  const lines = [`${result.verifierId} failed${result.targetRef ? ` on ${result.targetRef}` : ""}: ${result.message}`];
  const diagnostics = result.diagnostics;
  if (!diagnostics) return lines[0];
  if (diagnostics.target) lines.push(`Target: ${diagnostics.target}`);
  if (diagnostics.missing?.length) lines.push(`Missing fields:\n${diagnostics.missing.map((item) => `  - ${item}`).join("\n")}`);
  if (diagnostics.invalid?.length) lines.push(`Invalid fields:\n${diagnostics.invalid.map((item) => `  - ${item}`).join("\n")}`);
  if (diagnostics.found?.length) lines.push(`Found usable fields:\n${diagnostics.found.map((item) => `  - ${item}`).join("\n")}`);
  if (diagnostics.requiredFixes?.length) lines.push(`Required fixes:\n${diagnostics.requiredFixes.map((item) => `  - ${item}`).join("\n")}`);
  if (diagnostics.hints?.length) lines.push(`Hints:\n${diagnostics.hints.map((item) => `  - ${item}`).join("\n")}`);
  return lines.join("\n");
}

export async function createArtifactManifest(services: RuntimeServices, artifactIds: string[]): Promise<{ artifacts: { id: string; type: string; mediaType: string; stage?: string; role?: string; size: number; createdAt: string }[]; byStage: Record<string, string[]>; byRole: Record<string, string[]> }> {
  const artifacts = [];
  const byStage: Record<string, string[]> = {};
  const byRole: Record<string, string[]> = {};
  for (const id of [...new Set(artifactIds)]) {
    const artifact = await services.artifactStore.get(id);
    if (!artifact) continue;
    let stage: string | undefined;
    if (artifact.mediaType === "application/json") {
      try {
        const parsed = JSON.parse((await services.artifactStore.read(id)).toString("utf8"));
        if (typeof parsed?.stage === "string") stage = parsed.stage;
      } catch {
        // Ignore non-JSON content with a JSON media type.
      }
    }
    const role = stageToArtifactRole(stage) ?? artifact.type;
    artifacts.push({ id: artifact.id, type: artifact.type, mediaType: artifact.mediaType, stage, role, size: artifact.size, createdAt: artifact.createdAt });
    if (stage) byStage[stage] = [...(byStage[stage] ?? []), artifact.id];
    if (role) byRole[role] = [...(byRole[role] ?? []), artifact.id];
  }
  return { artifacts, byStage, byRole };
}

function stageToArtifactRole(stage?: string): string | undefined {
  const roles: Record<string, string> = {
    protocol: "protocol",
    queries: "query_plan",
    identification: "identification",
    citation_chaining: "citation_chaining",
    deduplication: "deduped_papers",
    screening_log: "screening_log",
    eligibility_log: "eligibility_log",
    quality_assessment: "quality_assessment",
    included_studies: "included_studies",
    evidence_table: "evidence_table",
    contradiction_detection: "contradiction_detection",
    citation_verification: "citation_verification",
    prisma_flow: "prisma_flow",
    verifier_report: "verifier_report",
    review_findings: "review_findings"
  };
  return stage ? roles[stage] : undefined;
}

export async function countMatchingArtifacts(services: RuntimeServices, artifactIds: string[], req: ArtifactRequirement): Promise<number> {
  let count = 0;
  for (const id of artifactIds) {
    const artifact = await services.artifactStore.get(id);
    if (!artifact) continue;
    if (req.type && artifact.type !== req.type) continue;
    if (req.mediaType && artifact.mediaType !== req.mediaType) continue;
    if (req.stage) {
      try {
        const parsed = JSON.parse((await services.artifactStore.read(id)).toString("utf8"));
        if (parsed?.stage !== req.stage) continue;
      } catch {
        continue;
      }
    }
    count++;
  }
  return count;
}
