/**
 * The one tool that runs the whole analysis.
 *
 * Search, ingest, classify, cluster, assess — in that order, in one call. It is
 * a single tool rather than five because the steps are not independently useful:
 * a classification with nothing to cluster is not an answer, and letting the
 * agent drive the sequence invites it to skip the channel half or to re-score
 * groups on its own.
 *
 * The agent gets structured data back and renders it with mention_group_card and
 * reputation_summary. Everything countable was computed before it got here.
 */
import { defineChannelTool } from "@copilotkit/channels";
import {
  assessAndRank,
  classifyMentions,
  clusterMentions,
  ingestMany,
  searchComplaints,
  type ClassifiedMention,
  type RawMention,
} from "agent-core";
import { z } from "zod";

/** Priority of a group is the highest priority among its mentions. */
const PRIORITY_RANK = { baja: 0, media: 1, alta: 2 } as const;

function groupPriority(mentions: ClassifiedMention[]): "baja" | "media" | "alta" {
  return mentions.reduce<"baja" | "media" | "alta">(
    (highest, mention) =>
      PRIORITY_RANK[mention.prioridad] > PRIORITY_RANK[highest] ? mention.prioridad : highest,
    "baja",
  );
}

export const analyzeReputation = defineChannelTool({
  name: "analyze_reputation",
  description:
    "Run the full reputation analysis for a company: search forums and the open web in several languages, fold in the complaints the team supplied, classify and translate every mention, group the ones describing the same failure, and mark which groups crossed the incident threshold. Call read_thread FIRST and pass anything the team pasted through `menciones_del_canal` — leaving it out silently drops half the evidence. Render the result with reputation_summary and mention_group_card. The counts and the incident flags are computed here: report them as returned, never recompute or re-judge them.",
  parameters: z.object({
    empresa: z.string().min(1).describe("The company to analyse."),
    idioma_objetivo: z
      .string()
      .min(2)
      .default("español")
      .describe("Language every summary and description comes back in, e.g. 'español', 'English'."),
    menciones_del_canal: z
      .array(
        z.object({
          texto: z.string().optional().describe("Complaint text a teammate pasted verbatim."),
          url: z.string().optional().describe("A link a teammate pasted."),
        }),
      )
      .max(25)
      .default([])
      .describe(
        "Complaints the team supplied in this channel, from read_thread. Pass every one you saw. These carry the same weight as search results.",
      ),
  }),
  async handler({ empresa, idioma_objetivo, menciones_del_canal }, { signal }) {
    const notas: string[] = [];

    // 1. The open web, in six queries across four languages.
    const sweep = await searchComplaints({ company: empresa });
    const searchMentions: RawMention[] =
      typeof sweep === "string"
        ? []
        : sweep.map((hit, index) => ({
            id: `web-${index + 1}`,
            // Title plus highlight is all Exa returns without a second fetch. It
            // is thin, and classification is told to prefer "otro"/"baja" over
            // inventing detail when the text is too thin to judge.
            text: [hit.title, hit.highlight].filter(Boolean).join("\n"),
            origin: "busqueda" as const,
            url: hit.url,
            published: hit.published,
          }));
    if (typeof sweep === "string") notas.push(sweep);

    // 2. What the team pasted. Failures are kept, not swallowed.
    const ingested = await ingestMany(
      menciones_del_canal.map((item, index) => ({
        text: item.texto,
        url: item.url,
        id: `canal-${index + 1}`,
      })),
    );
    for (const failure of ingested.failures) notas.push(failure.message);

    const mentions = [...searchMentions, ...ingested.mentions];
    if (mentions.length === 0) {
      return {
        empresa,
        grupos: [],
        notas,
        resumen:
          "No mentions could be gathered — neither the web sweep nor the channel produced anything readable. Say exactly that, relay the notes, and ask the team to paste complaint text directly. Do not produce an analysis of zero mentions.",
      };
    }

    // 3. Classify and translate each mention independently.
    const { classified, failures } = await classifyMentions(mentions, {
      targetLanguage: idioma_objetivo,
      signal,
    });
    if (failures.length > 0) {
      notas.push(
        `${failures.length} mención(es) no pudieron clasificarse y quedaron fuera del análisis.`,
      );
    }
    if (classified.length === 0) {
      return {
        empresa,
        grupos: [],
        notas,
        resumen:
          "Every mention failed classification, so there is nothing to group. Report the failure plainly; do not describe the mentions from their URLs.",
      };
    }

    // 4. Group by shared failure, across languages.
    const { grupos, reparaciones } = await clusterMentions(classified, {
      targetLanguage: idioma_objetivo,
      signal,
    });
    if (reparaciones.length > 0) {
      notas.push(`Agrupación corregida automáticamente: ${reparaciones.join("; ")}.`);
    }

    // 5. The incident verdict — pure code, no model, same answer every run.
    const ranked = assessAndRank(grupos);

    return {
      empresa,
      idioma_objetivo,
      total_menciones: classified.length,
      menciones_de_busqueda: classified.filter((m) => m.origen === "busqueda").length,
      menciones_del_canal: classified.filter((m) => m.origen === "canal").length,
      grupos: ranked.map((grupo) => ({
        descripcion: grupo.descripcion,
        prioridad: groupPriority(grupo.menciones),
        menciones: grupo.menciones.length,
        fuentes_distintas: grupo.fuentes_distintas,
        es_incidente: grupo.incidente.esIncidente,
        condiciones: grupo.incidente.condiciones,
        mencion_mas_antigua: grupo.mencion_mas_antigua,
        mencion_mas_reciente: grupo.mencion_mas_reciente,
        idiomas: [...new Set(grupo.menciones.map((m) => m.idioma_original))],
        fuentes: grupo.menciones
          .filter((m) => m.url)
          .map((m) => ({ titulo: m.resumen.slice(0, 60), url: m.url! })),
      })),
      notas,
    };
  },
});
