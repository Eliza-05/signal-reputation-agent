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
  it("never exceeds the concurrency limit, so a burst cannot trip a rate limit", async () => {
    // This is what produced "Rate limit exceeded" in Slack: every mention fired
    // at once against an account capped near 20 requests per minute.
    const mentions: RawMention[] = Array.from({ length: 12 }, (_, index) => ({
      id: `m${index}`,
      text: "queja",
      origin: "busqueda" as const,
    }));

    let inFlight = 0;
    let peak = 0;
    const { classified } = await classifyMentions(mentions, {
      ...options,
      concurrency: 3,
      complete: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return JSON.stringify(valid);
      },
    });

    assert.equal(classified.length, 12, "every mention must still be classified");
    assert.ok(peak <= 3, `expected at most 3 concurrent calls, saw ${peak}`);
  });

  it("keeps results aligned with their mentions when some fail mid-pool", async () => {
    // A worker pool writes results out of order; an off-by-one here would
    // attribute one mention's classification to another.
    const mentions: RawMention[] = Array.from({ length: 6 }, (_, index) => ({
      id: `m${index}`,
      text: `texto-${index}`,
      origin: "busqueda" as const,
    }));

    const { classified, failures } = await classifyMentions(mentions, {
      ...options,
      concurrency: 2,
      complete: async ({ prompt }) =>
        /texto-[13]\b/.test(prompt) ? "no json" : JSON.stringify(valid),
    });

    assert.deepEqual(failures.map((f) => f.id).sort(), ["m1", "m3"]);
    assert.deepEqual(
      classified.map((m) => m.id).sort(),
      ["m0", "m2", "m4", "m5"],
    );
  });

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
