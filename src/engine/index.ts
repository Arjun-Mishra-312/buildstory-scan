/**
 * Worker-safe report engine. This module must not import git, filesystem
 * session adapters, the CLI, Ink, or Node-only validation (schema file reads).
 * Cloudflare Workers import `buildstory-scan/engine`.
 */

export type {
  AnalysisTier,
  GeneratedNarrative,
  GitAggregateMetrics,
  NarrativeExcerpt,
  NarrativeEvidenceBundle,
  ProjectSnapshot,
  ProviderId,
  ReportStoryPack,
  ReportStoryPackV2,
  ReportStoryPackV3,
  SessionSummary,
  Signal,
  SignalFamily,
  StoryPackSource,
  UsageSummary,
} from "../contract.js";
export { PROJECT_SNAPSHOT_SCHEMA_VERSION, SCANNER_VERSION } from "../contract.js";
export { canonicalJson, sha256 } from "../canonical-json.js";
export {
  ARCHETYPES,
  PROFILE_DIMENSIONS,
  archetypeFacetKey,
  canonicalArchetypeName,
  computeBuilderProfile,
  defaultProfileNarrative,
  type Archetype,
  type BuilderProfile,
  type ComputedArchetype,
  type ProfileDimension,
  type ProfileInputs,
  type ProfileNarrativeSections,
  type ProfileScore,
} from "../insights/profile.js";
export { computeSignals, type SignalInputs } from "../insights/signals.js";
export {
  STORY_PACK_INSIGHTS_SCHEMA,
  STORY_PACK_STORY_SCHEMA,
  buildStoryPackSources,
  createDefaultStoryPack,
  sanitizeStoryPack,
  sectionsFromStoryPack,
} from "../narrative/story-pack.js";
export { Redactor, detectKnownSecrets } from "../redaction.js";
export { detectPrivateLocations } from "../privacy-boundary.js";
export {
  NARRATIVE_COMBINED_RESPONSE_FORMAT,
  NARRATIVE_DEEP_ANALYSIS_RESPONSE_FORMAT,
  NARRATIVE_DEEP_SYNTHESIS_RESPONSE_FORMAT,
  NARRATIVE_PROFILE_RESPONSE_FORMAT,
  NARRATIVE_RESPONSE_FORMAT,
  NARRATIVE_SYSTEM_PROMPT,
  STORY_PACK_DEEP_ANALYSIS_SCHEMA,
  STORY_PACK_DEEP_NARRATIVE_SCHEMA,
  STORY_PACK_OUTPUT_SCHEMA,
  buildCombinedMessages,
  buildDeepAnalysisMessages,
  buildDeepSynthesisMessages,
  buildNarrativeMessages,
  buildProfileMessages,
} from "./prompt.js";
