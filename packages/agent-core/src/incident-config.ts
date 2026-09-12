/**
 * The incident thresholds, alone in their own file so they can be argued about
 * and changed without reading any logic.
 *
 * Raise `minMentions` or `minDistinctSources` if the demo is alerting on noise.
 * Lower `recentWithinHours` if stale complaints are keeping groups alive.
 */
export interface IncidentThresholds {
  /** How many mentions a group needs. One angry user is not an incident. */
  minMentions: number;
  /**
   * How many distinct sources. Ten posts on one forum thread are one room
   * talking; two rooms talking is a signal.
   */
  minDistinctSources: number;
  /** How recent the newest mention must be. A solved problem stops mattering. */
  recentWithinHours: number;
}

export const DEFAULT_INCIDENT_THRESHOLDS: IncidentThresholds = {
  minMentions: 3,
  minDistinctSources: 2,
  recentWithinHours: 48,
};
