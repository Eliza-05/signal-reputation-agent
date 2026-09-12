/**
 * Is this group an incident?
 *
 * No model runs here, and that is the point. "This is an incident" is the claim
 * that makes someone drop what they are doing, so it has to be reproducible,
 * inspectable, and identical on every run. A model asked the same question
 * twice can answer differently, and nobody could tell you why.
 *
 * Three conditions, all required. Thresholds live in `incident-config.ts`.
 */
import {
  DEFAULT_INCIDENT_THRESHOLDS,
  type IncidentThresholds,
} from "./incident-config";
import type { MentionGroup } from "./cluster";

export interface IncidentAssessment {
  esIncidente: boolean;
  /** Each condition individually, so a card can show what is missing. */
  condiciones: {
    suficientesMenciones: boolean;
    suficientesFuentes: boolean;
    suficientementeReciente: boolean;
  };
  menciones: number;
  fuentes_distintas: number;
  /** Hours since the newest mention; undefined when no mention carried a date. */
  horasDesdeUltimaMencion?: number;
  umbrales: IncidentThresholds;
}

export function assessIncident(
  group: MentionGroup,
  thresholds: IncidentThresholds = DEFAULT_INCIDENT_THRESHOLDS,
  now: Date = new Date(),
): IncidentAssessment {
  const menciones = group.menciones.length;
  const fuentes_distintas = group.fuentes_distintas;

  const newest = group.mencion_mas_reciente
    ? Date.parse(group.mencion_mas_reciente)
    : Number.NaN;
  const horasDesdeUltimaMencion = Number.isFinite(newest)
    ? (now.getTime() - newest) / 3_600_000
    : undefined;

  const suficientesMenciones = menciones >= thresholds.minMentions;
  const suficientesFuentes = fuentes_distintas >= thresholds.minDistinctSources;
  // An undated group fails this condition rather than passing it. Unknown is not
  // the same as recent, and guessing in the permissive direction is how a tool
  // starts crying wolf.
  const suficientementeReciente =
    horasDesdeUltimaMencion !== undefined &&
    horasDesdeUltimaMencion >= 0 &&
    horasDesdeUltimaMencion <= thresholds.recentWithinHours;

  return {
    esIncidente:
      suficientesMenciones && suficientesFuentes && suficientementeReciente,
    condiciones: {
      suficientesMenciones,
      suficientesFuentes,
      suficientementeReciente,
    },
    menciones,
    fuentes_distintas,
    horasDesdeUltimaMencion,
    umbrales: thresholds,
  };
}

/** A group with its verdict attached, which is what the cards render. */
export interface AssessedGroup extends MentionGroup {
  incidente: IncidentAssessment;
}

/**
 * Incidents first, then by how much evidence there is. Urgency here is a
 * property of the pile of mentions, never of how alarming one of them sounded.
 */
export function assessAndRank(
  groups: MentionGroup[],
  thresholds: IncidentThresholds = DEFAULT_INCIDENT_THRESHOLDS,
  now: Date = new Date(),
): AssessedGroup[] {
  return groups
    .map((group) => ({ ...group, incidente: assessIncident(group, thresholds, now) }))
    .sort((a, b) => {
      if (a.incidente.esIncidente !== b.incidente.esIncidente) {
        return a.incidente.esIncidente ? -1 : 1;
      }
      if (a.menciones.length !== b.menciones.length) {
        return b.menciones.length - a.menciones.length;
      }
      return b.fuentes_distintas - a.fuentes_distintas;
    });
}
