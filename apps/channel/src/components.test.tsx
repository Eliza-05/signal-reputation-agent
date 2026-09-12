/**
 * Component tests.
 *
 * `renderToIR` lowers a Channels JSX tree to the platform-neutral IR the
 * adapter is actually handed — `{ type, props }` nodes — so these run with no
 * Slack app, no Intelligence project and no credentials of any kind.
 *
 * That matters for a hackathon kit: change a card, know in a second whether you
 * broke it. Node's built-in runner means there is nothing to install either.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToIR } from "@copilotkit/channels";
import { MentionGroupCard, ReputationSummary } from "./components";

const ctx = { platform: "slack" as const, signal: new AbortController().signal };

/** The rendered IR as a searchable string. */
async function render(node: unknown): Promise<string> {
  return JSON.stringify(renderToIR((await node) as never));
}

const baseGroup = {
  descripcion: "Cobro duplicado tras cancelar la suscripción",
  prioridad: "alta" as const,
  menciones: 4,
  fuentes_distintas: 3,
  es_incidente: false,
  fuentes: [] as { titulo: string; url: string }[],
};

describe("mention_group_card", () => {
  it("colours the rail by priority, so the channel can triage by glance", async () => {
    const alta = await render(MentionGroupCard.render(baseGroup, ctx));
    const baja = await render(
      MentionGroupCard.render({ ...baseGroup, prioridad: "baja" }, ctx),
    );

    assert.ok(alta.includes("#C4145F"), "alta should use the attention accent");
    assert.ok(baja.includes("#5B6478"), "baja should use the muted accent");
    assert.notEqual(alta, baja);
  });

  it("labels the priority in words, not just colour", async () => {
    // Colour alone fails anyone colour-blind and every screen reader.
    const out = await render(MentionGroupCard.render(baseGroup, ctx));
    assert.ok(out.includes("Prioridad alta"));
  });

  it("makes an incident outrank its own priority colour", async () => {
    // An incident must not be able to hide behind a calm rail because the
    // individual mentions happened to score 'media'.
    const incidente = await render(
      MentionGroupCard.render(
        { ...baseGroup, prioridad: "media", es_incidente: true },
        ctx,
      ),
    );
    assert.ok(incidente.includes("#B3261E"), "incident accent must win");
    assert.ok(incidente.includes("Incidente"));
    assert.ok(incidente.includes("umbral de incidente"));
  });

  it("always carries both counts — four complaints from one forum is not four sources", async () => {
    const out = await render(MentionGroupCard.render(baseGroup, ctx));
    assert.ok(out.includes("Menciones"));
    assert.ok(out.includes("Fuentes distintas"));
    assert.ok(out.includes("4"));
    assert.ok(out.includes("3"));
  });

  it("renders a link button per source and says so when there are none", async () => {
    const withLinks = await render(
      MentionGroupCard.render(
        {
          ...baseGroup,
          fuentes: [
            { titulo: "Hilo en foro", url: "https://example.com/a" },
            { titulo: "Reseña", url: "https://otro.example/b" },
          ],
        },
        ctx,
      ),
    );
    assert.ok(withLinks.includes("https://example.com/a"));
    assert.ok(withLinks.includes("https://otro.example/b"));
    assert.ok(withLinks.includes("1. Hilo en foro"));

    // A card with no links must explain why, or it reads as a card that lost them.
    const withoutLinks = await render(MentionGroupCard.render(baseGroup, ctx));
    assert.ok(withoutLinks.includes("Sin enlaces públicos"));
  });
});

describe("reputation_summary", () => {
  const grupos = [
    {
      descripcion: "Sugerencia sobre el tema oscuro",
      prioridad: "baja" as const,
      menciones: 1,
      fuentes_distintas: 1,
      es_incidente: false,
    },
    {
      descripcion: "Cobro duplicado tras cancelar",
      prioridad: "alta" as const,
      menciones: 5,
      fuentes_distintas: 3,
      es_incidente: true,
    },
    {
      descripcion: "La app va lenta al abrir",
      prioridad: "media" as const,
      menciones: 2,
      fuentes_distintas: 2,
      es_incidente: false,
    },
  ];

  it("puts incidents first regardless of the order they arrived in", async () => {
    // The first row is the one that gets read; the rest often do not.
    const out = await render(
      ReputationSummary.render({ empresa: "Acme", grupos }, ctx),
    );
    const incidente = out.indexOf("Cobro duplicado");
    const media = out.indexOf("La app va lenta");
    const baja = out.indexOf("tema oscuro");

    assert.ok(incidente >= 0 && media >= 0 && baja >= 0);
    assert.ok(incidente < media, "the incident must outrank the media group");
    assert.ok(media < baja, "media must outrank baja");
  });

  it("counts mentions and incidents in the header", async () => {
    const out = await render(
      ReputationSummary.render({ empresa: "Acme", grupos }, ctx),
    );
    assert.ok(out.includes("Acme"));
    assert.ok(out.includes("8 mención(es)"));
    assert.ok(out.includes("3 grupo(s)"));
    assert.ok(out.includes("1 incidente(s)"));
  });

  it("omits the incident callout entirely when nothing crossed the threshold", async () => {
    const calm = grupos.map((grupo) => ({ ...grupo, es_incidente: false }));
    const out = await render(
      ReputationSummary.render({ empresa: "Acme", grupos: calm }, ctx),
    );
    assert.ok(!out.includes("cruzaron el umbral"));
    assert.ok(out.includes("0 incidente(s)"));
  });

  it("surfaces the gap note when part of the sweep could not be read", async () => {
    // A summary that silently drops unreadable sources overstates its coverage.
    const out = await render(
      ReputationSummary.render(
        { empresa: "Acme", grupos, nota: "2 enlaces no pudieron leerse." },
        ctx,
      ),
    );
    assert.ok(out.includes("2 enlaces no pudieron leerse."));
  });
});
