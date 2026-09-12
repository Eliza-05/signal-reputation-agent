/**
 * Clustering tests.
 *
 * `complete` is injected, so these exercise the parts that must not depend on a
 * model's mood: how many sources a group really has, and what happens when the
 * model returns something malformed. The grouping judgement itself lives in the
 * prompt and is checked by hand in Slack.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clusterMentions, buildGroup } from "./cluster";
import type { ClassifiedMention } from "./classify";

function mention(overrides: Partial<ClassifiedMention> = {}): ClassifiedMention {
  return {
    id: "m1",
    text: "me cobraron dos veces",
    resumen: "Le cobraron dos veces tras cancelar.",
    idioma_original: "es",
    categoria: "facturacion",
    prioridad: "alta",
    problema_nucleo: "charged again after cancelling subscription",
    es_queja: true,
    origen: "busqueda",
    url: "https://foro.example/hilo-1",
    published: "2026-09-11T10:00:00Z",
    ...overrides,
  };
}

const reply = (grupos: unknown) => async () => JSON.stringify({ grupos });

describe("buildGroup", () => {
  it("counts distinct hosts, not mentions — one forum thread is one source", () => {
    const grupo = buildGroup("cobro duplicado", [
      mention({ id: "a", url: "https://foro.example/hilo-1" }),
      mention({ id: "b", url: "https://foro.example/hilo-2" }),
      mention({ id: "c", url: "https://www.foro.example/hilo-3" }),
    ]);
    assert.equal(grupo.menciones.length, 3);
    assert.equal(grupo.fuentes_distintas, 1, "same host, with and without www");
  });

  it("collapses every link-less channel mention into one source", () => {
    // We cannot tell whether pasted text came from one platform or five, and
    // over-counting sources is exactly what manufactures a false incident.
    const grupo = buildGroup("cobro duplicado", [
      mention({ id: "a", url: undefined, origen: "canal" }),
      mention({ id: "b", url: undefined, origen: "canal" }),
      mention({ id: "c", url: "https://otro.example/x" }),
    ]);
    assert.equal(grupo.fuentes_distintas, 2);
  });

  it("reports the oldest and newest dated mention and ignores undated ones", () => {
    const grupo = buildGroup("cobro duplicado", [
      mention({ id: "a", published: "2026-09-11T10:00:00Z" }),
      mention({ id: "b", published: "2026-09-01T10:00:00Z" }),
      mention({ id: "c", published: undefined }),
    ]);
    assert.equal(grupo.mencion_mas_antigua, "2026-09-01T10:00:00Z");
    assert.equal(grupo.mencion_mas_reciente, "2026-09-11T10:00:00Z");
  });

  it("leaves both dates undefined when nothing in the group carried one", () => {
    const grupo = buildGroup("x", [mention({ published: undefined })]);
    assert.equal(grupo.mencion_mas_antigua, undefined);
    assert.equal(grupo.mencion_mas_reciente, undefined);
  });
});

describe("clusterMentions", () => {
  const options = { targetLanguage: "español" };

  it("groups mentions written in different languages under one failure", async () => {
    const es = mention({ id: "es1", idioma_original: "es" });
    const de = mention({
      id: "de1",
      idioma_original: "de",
      url: "https://forum.example/thread",
    });
    const { grupos } = await clusterMentions([es, de], {
      ...options,
      complete: reply([
        { descripcion: "Cobro duplicado tras cancelar", menciones: ["es1", "de1"] },
      ]),
    });

    assert.equal(grupos.length, 1);
    assert.equal(grupos[0]!.menciones.length, 2);
    assert.equal(grupos[0]!.fuentes_distintas, 2);
  });

  it("never calls the model for a single mention", async () => {
    // Asking a model to "group" one item only invites it to invent a theme.
    let called = false;
    const { grupos } = await clusterMentions([mention()], {
      ...options,
      complete: async () => {
        called = true;
        return "{}";
      },
    });
    assert.equal(called, false);
    assert.equal(grupos.length, 1);
    assert.equal(grupos[0]!.menciones.length, 1);
  });

  it("returns nothing at all for no mentions", async () => {
    const { grupos } = await clusterMentions([], options);
    assert.deepEqual(grupos, []);
  });

  it("keeps a forgotten mention as its own group instead of dropping it", async () => {
    // Splitting is the safe direction, so this repair can only ever under-alert.
    const { grupos, reparaciones } = await clusterMentions(
      [mention({ id: "a" }), mention({ id: "b" }), mention({ id: "c" })],
      { ...options, complete: reply([{ descripcion: "grupo", menciones: ["a", "b"] }]) },
    );

    const ids = grupos.flatMap((grupo) => grupo.menciones.map((m) => m.id)).sort();
    assert.deepEqual(ids, ["a", "b", "c"], "no mention may vanish");
    assert.equal(grupos.length, 2);
    assert.ok(reparaciones.some((note) => note.includes('"c"')));
  });

  it("refuses to place one mention in two groups", async () => {
    const { grupos, reparaciones } = await clusterMentions(
      [mention({ id: "a" }), mention({ id: "b" })],
      {
        ...options,
        complete: reply([
          { descripcion: "uno", menciones: ["a", "b"] },
          { descripcion: "dos", menciones: ["a"] },
        ]),
      },
    );
    const ids = grupos.flatMap((grupo) => grupo.menciones.map((m) => m.id));
    assert.equal(ids.length, 2, "a duplicated id must be counted once");
    assert.ok(reparaciones.some((note) => note.includes("more than one group")));
  });

  it("discards an id that was never in the input", async () => {
    const { grupos, reparaciones } = await clusterMentions(
      [mention({ id: "a" }), mention({ id: "b" })],
      {
        ...options,
        complete: reply([{ descripcion: "uno", menciones: ["a", "b", "fantasma"] }]),
      },
    );
    assert.equal(grupos[0]!.menciones.length, 2);
    assert.ok(reparaciones.some((note) => note.includes("fantasma")));
  });

  it("tolerates a fenced JSON reply", async () => {
    const { grupos } = await clusterMentions([mention({ id: "a" }), mention({ id: "b" })], {
      ...options,
      complete: async () =>
        '```json\n{"grupos":[{"descripcion":"uno","menciones":["a","b"]}]}\n```',
    });
    assert.equal(grupos.length, 1);
  });

  it("throws rather than guessing when the model returns prose", async () => {
    await assert.rejects(
      clusterMentions([mention({ id: "a" }), mention({ id: "b" })], {
        ...options,
        complete: async () => "I could not group these, sorry.",
      }),
      /parseable JSON/,
    );
  });
});
