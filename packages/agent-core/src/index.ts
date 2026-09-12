/**
 * Server surface. Importing this from a client component pulls
 * @copilotkit/runtime (and Express, and Node's `fs`) into the browser bundle.
 * Client code wants `agent-core/shared`.
 */
export { makeAgent } from "./agent";
export { MOBILE_FINANCE_PROMPT } from "./mobile-finance-prompt";
export { resolveModel } from "./model";
export {
  searchWeb,
  isSearchConfigured,
  buildComplaintQueries,
  searchComplaints,
  type ComplaintQuery,
  type ComplaintHit,
  type ComplaintTheme,
  type ComplaintSweepArgs,
} from "./capabilities/search";
export {
  workplaceMcpServers,
  isWorkplaceConfigured,
  WORKPLACE_CONTEXT,
} from "./capabilities/workplace";
export {
  ingestUrl,
  ingestText,
  ingestMany,
  type IngestResult,
  type IngestFailure,
} from "./capabilities/ingest";
export {
  classifyMention,
  classifyMentions,
  mentionClassificationSchema,
  ORIGINS,
  type RawMention,
  type ClassifiedMention,
  type MentionClassification,
  type MentionOrigin,
} from "./classify";
export {
  clusterMentions,
  buildGroup,
  type MentionGroup,
  type ClusterResult,
} from "./cluster";
export {
  assessIncident,
  assessAndRank,
  type IncidentAssessment,
  type AssessedGroup,
} from "./incident";
export {
  DEFAULT_INCIDENT_THRESHOLDS,
  type IncidentThresholds,
} from "./incident-config";
export { complete, resolveLanguageModel, parseJsonResponse, type CompleteFn } from "./llm";
export * from "./shared";
