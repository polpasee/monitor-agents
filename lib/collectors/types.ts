import type {
  AgentRun,
  Event,
  ExternalSpawn,
  QuotaLimit,
  SourceStatus,
} from "../telemetry";

export interface CollectorResult {
  agents: AgentRun[];
  events: Event[];
  externalSpawns?: ExternalSpawn[];
  quotaLimits: QuotaLimit[];
  source: SourceStatus;
}
