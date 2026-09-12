import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyMention, classifyMentions } from "./classify";
import type { RawMention } from "./classify";

const valid = {
  resumen: "Le cobraron dos veces tras cancelar la suscripción.",
  idioma_original: "de",
  categoria: "facturacion",
  prioridad: "alta",
  problema_nucleo: "charged again after cancelling subscription",
  es_queja: true,
  origen: "busqueda",
};

const raw: RawMention = {
  id: "m1",
  text: "Ich wurde nach der Kündigung erneut belastet.",
  origin: "canal",
  url: "https://forum.example/thread",
  published: "2026-09-11T10:00:00Z",
};

const options = { targetLanguage: "español" };

describe("classifyMention", () => {
  it("keeps the mention's own id, url and date alongside the classification", async () => {
    const result = await classifyMention(raw, {
      ...options,
      complete: async () => JSON.stringify(valid),
    });
    assert.equal(result.id, "m1");
    assert.equal(result.url, "https://forum.example/thread");
    assert.equal(result.published, "2026-09-11T10:00:00Z");
    assert.equal(result.problema_nucleo, "charged again after cancelling subscription");
  });

  it("overrides the origin the model returned with the one we actually know", async () => {
    // Where a mention came from is a fact about how we obtained it, not a
    // judgement. The model is told it and told not to change it; this enforces it.
    const result = await classifyMention(raw, {
      ...options,
      complete: async () => JSON.stringify({ ...valid, origen: "busqueda" }),
    });
    assert.equal(result.origen, "canal");
  });

  it("accepts a fenced reply, since models add fences unprompted", async () => {
    const result = await classifyMention(raw, {
      ...options,
      complete: async () => "```json\n" + JSON.stringify(valid) + "\n```",
    });
    assert.equal(result.categoria, "facturacion");
  });

  it("rejects a priority above the ceiling instead of passing it through", async () => {
    // "alta" is the ceiling by design: only the incident rule may escalate, and
    // it works on groups. A model inventing "critica" must not reach a card.
    await assert.rejects(
      classifyMention(raw, {
        ...options,
        complete: async () => JSON.stringify({ ...valid, prioridad: "critica" }),
      }),
    );
  });

  it("rejects a category outside the fixed set", async () => {
    await assert.rejects(
      classifyMention(raw, {
        ...options,
        complete: async () => JSON.stringify({ ...valid, categoria: "reputacion" }),
      }),
    );
  });

  it("throws rather than defaulting when the model returns prose", async () => {
    await assert.rejects(
      classifyMention(raw, { ...options, complete: async () => "No lo sé." }),
      /parseable JSON/,
    );
  });
});

describe("classifyMentions", () => {
  it("keeps the good mentions and reports the failed ones instead of hiding them", async () => {
    const mentions: RawMention[] = [
      { id: "ok1", text: "a", origin: "busqueda" },
      { id: "bad", text: "b", origin: "busqueda" },
      { id: "ok2", text: "c", origin: "canal" },
    ];
    const { classified, failures } = await classifyMentions(mentions, {
      ...options,
      complete: async ({ prompt }) =>
        prompt.includes('"""\nb\n"""') ? "not json at all" : JSON.stringify(valid),
    });

    assert.equal(classified.length, 2);
    assert.deepEqual(classified.map((m) => m.id).sort(), ["ok1", "ok2"]);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.id, "bad");
  });
});
