import { RuntimeError, type RuntimeServices } from "@jiuwen-sci/core";
import type { LiteratureConnector } from "../types.js";
import { ArxivConnector, BioRxivConnector, CrossrefConnector, EuropePmcConnector, OpenAlexConnector, PubMedConnector, SemanticScholarConnector } from "./sources.js";

export class LiteratureConnectorRegistry {
  private connectors = new Map<string, LiteratureConnector>();
  register(connector: LiteratureConnector): void {
    if (this.connectors.has(connector.id)) throw new RuntimeError("CONNECTOR_DUPLICATE", connector.id);
    this.connectors.set(connector.id, connector);
  }
  get(id: string): LiteratureConnector | null { return this.connectors.get(id) ?? null; }
  list(): LiteratureConnector[] { return [...this.connectors.values()]; }
}

const REGISTRY_KEY = "literature.connectorRegistry";

export function getLiteratureConnectorRegistry(services: RuntimeServices): LiteratureConnectorRegistry {
  let registry = services.extensions.get(REGISTRY_KEY) as LiteratureConnectorRegistry | undefined;
  if (!registry) {
    registry = new LiteratureConnectorRegistry();
    registry.register(new OpenAlexConnector());
    registry.register(new ArxivConnector());
    registry.register(new CrossrefConnector());
    registry.register(new PubMedConnector());
    registry.register(new EuropePmcConnector());
    registry.register(new SemanticScholarConnector());
    registry.register(new BioRxivConnector("biorxiv"));
    registry.register(new BioRxivConnector("medrxiv"));
    services.extensions.set(REGISTRY_KEY, registry);
  }
  return registry;
}
