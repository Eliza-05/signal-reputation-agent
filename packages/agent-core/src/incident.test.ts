/**
 * The incident rule is the claim that makes someone drop what they are doing,
 * so it is the thing most worth pinning down. No model runs in these tests
 * because no model runs in the rule.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assessIncident, assessAndRank } from "./incident";
import { DEFAULT_INCIDENT_THRESHOLDS } from "./incident-config";
import type { MentionGroup } from "./cluster";

const NOW = new Date("2026-09-12T12:00:00Z");

function group(overrides: Partial<MentionGroup> = {}): MentionGroup {
  return {
    descripcion: "Cobro duplicado tras cancelar",
    menciones: [{}, {}, {}] as MentionGroup["menciones"],
    fuentes_distintas: 2,
    mencion_mas_reciente: "2026-09-12T06:00:00Z",
    mencion_mas_antigua: "2026-09-10T06:00:00Z",
    ...overrides,
  };
}

describe("assessIncident", () => {
  it("marks a group that meets all three conditions", () => {
    const verdict = assessIncident(group(), DEFAULT_INCIDENT_THRESHOLDS, NOW);
    assert.equal(verdict.esIncidente, true);
    assert.deepEqual(verdict.condiciones, {
      suficientesMenciones: true,
      suficientesFuentes: true,
      suficientementeReciente: true,
    });
  });

  it("requires all three, not a majority", () => {
    const cases: [string, MentionGroup][] = [
      ["too few mentions", group({ menciones: [{}, {}] as MentionGroup["menciones"] })],
      ["one source only", group({ fuentes_distintas: 1 })],
      ["too old", group({ mencion_mas_reciente: "2026-09-01T06:00:00Z" })],
    ];
    for (const [label, candidate] of cases) {
      const verdict = assessIncident(candidate, DEFAULT_INCIDENT_THRESHOLDS, NOW);
      assert.equal(verdict.esIncidente, false, `${label} must not be an incident`);
    }
  });

  it("reports which condition failed, so a card can say what is missing", () => {
    const verdict = assessIncident(
      group({ fuentes_distintas: 1 }),
      DEFAULT_INCIDENT_THRESHOLDS,
      NOW,
    );
    assert.equal(verdict.condiciones.suficientesFuentes, false);
    assert.equal(verdict.condiciones.suficientesMenciones, true);
    assert.equal(verdict.condiciones.suficientementeReciente, true);
  });

  it("treats an undated group as not-recent rather than as recent", () => {
    // Unknown is not the same as recent. Guessing in the permissive direction is
    // how a monitoring tool starts crying wolf.
    const verdict = assessIncident(
      group({ mencion_mas_reciente: undefined, mencion_mas_antigua: undefined }),
      DEFAULT_INCIDENT_THRESHOLDS,
      NOW,
    );
    assert.equal(verdict.condiciones.suficientementeReciente, false);
    assert.equal(verdict.esIncidente, false);
    assert.equal(verdict.horasDesdeUltimaMencion, undefined);
  });

  it("honours custom thresholds instead of the defaults", () => {
    const strict = { minMentions: 5, minDistinctSources: 4, recentWithinHours: 2 };
    assert.equal(assessIncident(group(), strict, NOW).esIncidente, false);

    const loose = { minMentions: 1, minDistinctSources: 1, recentWithinHours: 500 };
    assert.equal(
      assessIncident(group({ fuentes_distintas: 1 }), loose, NOW).esIncidente,
      true,
    );
  });

  it("does not count a future timestamp as recent", () => {
    const verdict = assessIncident(
      group({ mencion_mas_reciente: "2027-01-01T00:00:00Z" }),
      DEFAULT_INCIDENT_THRESHOLDS,
      NOW,
    );
    assert.equal(verdict.condiciones.suficientementeReciente, false);
  });
});

describe("assessAndRank", () => {
  it("puts incidents first, then the groups with the most evidence", () => {
    const ranked = assessAndRank(
      [
        group({ descripcion: "una sola mención", menciones: [{}] as MentionGroup["menciones"], fuentes_distintas: 1 }),
        group({ descripcion: "incidente" }),
        group({
          descripcion: "muchas menciones, una fuente",
          menciones: [{}, {}, {}, {}, {}] as MentionGroup["menciones"],
          fuentes_distintas: 1,
        }),
      ],
      DEFAULT_INCIDENT_THRESHOLDS,
      NOW,
    );

    assert.equal(ranked[0]!.descripcion, "incidente");
    assert.equal(ranked[0]!.incidente.esIncidente, true);
    assert.equal(ranked[1]!.descripcion, "muchas menciones, una fuente");
    assert.equal(ranked[2]!.descripcion, "una sola mención");
  });
});
