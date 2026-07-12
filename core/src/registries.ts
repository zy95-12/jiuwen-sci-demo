import { RuntimeError } from "./errors.js";
import type {
  AgentDefinition,
  CapabilityPack,
  ReviewerDefinition,
  StageContractDefinition,
  StageVerifierDefinition,
  ToolDefinition,
  WorkflowDefinition
} from "./types.js";

export class InMemoryAgentRegistry {
  private agents = new Map<string, AgentDefinition>();
  register(agent: AgentDefinition): void {
    if (this.agents.has(agent.id)) throw new RuntimeError("AGENT_DUPLICATE", agent.id);
    this.agents.set(agent.id, agent);
  }
  get(id: string): AgentDefinition | null { return this.agents.get(id) ?? null; }
  list(filter: { mode?: string } = {}): AgentDefinition[] {
    return [...this.agents.values()].filter((a) => !filter.mode || a.mode === filter.mode || a.mode === "all");
  }
  canRunAs(id: string, mode: "primary" | "subagent" | "system"): boolean {
    const a = this.get(id);
    if (!a) return false;
    if (a.mode === "all") return mode !== "system";
    return a.mode === mode;
  }
}

export class InMemoryToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.id)) throw new RuntimeError("TOOL_DUPLICATE", tool.id);
    this.tools.set(tool.id, tool);
  }
  get(id: string): ToolDefinition | null { return this.tools.get(id) ?? null; }
  list(): ToolDefinition[] { return [...this.tools.values()]; }
  listForAgent(agent: AgentDefinition): ToolDefinition[] {
    return agent.allowedTools ? agent.allowedTools.map((id) => this.get(id)).filter((t): t is ToolDefinition => Boolean(t)) : this.list();
  }
}

export class InMemoryReviewerRegistry {
  private reviewers = new Map<string, ReviewerDefinition>();
  register(reviewer: ReviewerDefinition): void { this.reviewers.set(reviewer.id, reviewer); }
  get(id: string): ReviewerDefinition | null { return this.reviewers.get(id) ?? null; }
  list(): ReviewerDefinition[] { return [...this.reviewers.values()]; }
}

export class InMemoryStageVerifierRegistry {
  private verifiers = new Map<string, StageVerifierDefinition>();
  register(verifier: StageVerifierDefinition): void {
    if (this.verifiers.has(verifier.id)) throw new RuntimeError("VERIFIER_DUPLICATE", verifier.id);
    this.verifiers.set(verifier.id, verifier);
  }
  get(id: string): StageVerifierDefinition | null { return this.verifiers.get(id) ?? null; }
  list(): StageVerifierDefinition[] { return [...this.verifiers.values()]; }
}

export class InMemoryPackRegistry {
  private packs = new Map<string, CapabilityPack>();
  private workflows = new Map<string, WorkflowDefinition>();
  private stageContracts = new Map<string, StageContractDefinition>();
  register(pack: CapabilityPack): void {
    if (this.packs.has(pack.id)) return;
    this.packs.set(pack.id, pack);
    for (const workflow of pack.workflows ?? []) this.workflows.set(workflow.id, workflow);
    for (const contract of pack.stageContracts ?? []) this.stageContracts.set(contract.id, contract);
  }
  get(id: string): CapabilityPack | null { return this.packs.get(id) ?? null; }
  list(): CapabilityPack[] { return [...this.packs.values()]; }
  getWorkflow(id: string): WorkflowDefinition | null { return this.workflows.get(id) ?? null; }
  getStageContract(id: string): StageContractDefinition | null { return this.stageContracts.get(id) ?? null; }
  workflowCatalog(): { packId: string; packName: string; workflowId: string; workflowName: string; description: string }[] {
    return [...this.packs.values()].flatMap((pack) => (pack.workflows ?? []).map((workflow) => ({
      packId: pack.id,
      packName: pack.name,
      workflowId: workflow.id,
      workflowName: workflow.name,
      description: workflow.description
    })));
  }
  stageContractCatalog(): { packId: string; packName: string; contractId: string; contractName: string; description: string }[] {
    return [...this.packs.values()].flatMap((pack) => (pack.stageContracts ?? []).map((contract) => ({
      packId: pack.id,
      packName: pack.name,
      contractId: contract.id,
      contractName: contract.name,
      description: contract.description
    })));
  }
}
