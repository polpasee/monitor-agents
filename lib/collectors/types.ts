import type {
  AgentRun,
  Event,
  QuotaLimit,
  SourceStatus,
} from "../telemetry";

export interface CollectorResult {
  agents: AgentRun[];
  events: Event[];
  quotaLimits: QuotaLimit[];
  source: SourceStatus;
}
