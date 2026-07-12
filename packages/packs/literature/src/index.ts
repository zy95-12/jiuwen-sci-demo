import type { CapabilityPack } from "@jiuwen-sci/core";
import { getLiteratureConnectorRegistry } from "./connectors/registry.js";
import { literatureAgents } from "./config/agents.js";
import { literatureTools } from "./tools.js";
import { literatureStageVerifiers } from "./verifiers.js";
import { literatureReviewStageContract, literatureReviewWorkflow } from "./workflow/stage-contract.js";

export type { ConnectorCapability, ConnectorMetadata, LiteratureConnector, LiteratureSearchInput, PaperHit, PreferenceScore, SourceError, SourceErrorType, TopicExpansion, TopicProfile } from "./types.js";
export { normalizeLiteratureDatabaseIds } from "./connectors/databases.js";
export { toArxivSearchQuery } from "./connectors/arxiv-query.js";
export { LiteratureConnectorRegistry, getLiteratureConnectorRegistry } from "./connectors/registry.js";
export { ArxivConnector, BioRxivConnector, CrossrefConnector, EuropePmcConnector, OpenAlexConnector, PubMedConnector, SemanticScholarConnector } from "./connectors/sources.js";
export { bibtexWriteTool, citationChainTool, citationCheckTool, citationVerifyTool, evidenceTableWriteTool, literatureTools, paperDeduplicateTool, paperFetchTool, prismaFlowWriteTool, scienceListDbsTool, scienceSearchTool } from "./tools.js";
export { literatureReviewStageContract, literatureReviewWorkflow } from "./workflow/stage-contract.js";

export const literaturePack: CapabilityPack = {
  id: "literature",
  name: "Literature Research Pack",
  version: "0.3.0",
  description: "PRISMA-style literature review workflows and scholarly database connectors.",
  agents: literatureAgents,
  tools: literatureTools,
  reviewers: [],
  workflows: [literatureReviewWorkflow],
  stageContracts: [literatureReviewStageContract],
  activate(services) {
    getLiteratureConnectorRegistry(services);
    for (const verifier of literatureStageVerifiers) {
      if (!services.verifierRegistry.get(verifier.id)) services.verifierRegistry.register(verifier);
    }
  }
};

export default literaturePack;
