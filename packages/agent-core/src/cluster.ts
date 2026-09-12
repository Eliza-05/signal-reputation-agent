/**
 * Group classified mentions by the failure they describe.
 *
 * The model decides one thing only: which mentions describe the same problem,
 * and how to say it in one sentence. Everything countable — how many distinct
 * sources, oldest and newest mention — is computed here from the mentions
 * themselves. Counts are what the incident test runs on, and a model asked to
 * count will occasionally be wrong in a way nobody notices.
 */
import { z } from "zod";
import { complete as defaultComplete, parseJsonResponse, type CompleteFn } from "./llm";
import type { ClassifiedMention } from "./classify";
import { clusterSystemPrompt, clusterUserPrompt } from "./prompts/cluster";

const clusterResponseSchema = z.object({
  grupos: z
    .array(
      z.object({
        descripcion: z.string().min(1),
        menciones: z.array(z.string()).min(1),
      }),
    )
    .min(1),
});

export interface MentionGroup {
  descripcion: string;
  menciones: ClassifiedMention[];
  /** Distinct hostnames; every mention pasted into the channel shares one. */
  fuentes_distintas: number;
  /** ISO timestamps, or undefined when no mention in the group carried a date. */
  mencion_mas_antigua?: string;
  mencion_mas_reciente?: string;
}

export interface ClusterOptions {
  targetLanguage: string;
  complete?: CompleteFn;
  signal?: AbortSignal;
}

export interface ClusterResult {
  grupos: MentionGroup[];
  /**
   * Ids the model dropped or repeated, recovered here. Non-empty means the
   * grouping was patched up, which is worth saying out loud in the thread.
   */
  reparaciones: string[];
}

/**
 * Two complaints on the same forum are one source agreeing with itself; two on
 * different domains are two. Mentions a teammate pasted with no link all share
 * the single source "canal" — deliberately conservative, since we cannot tell
 * whether they came from one platform or five, and over-counting sources is
 * what manufactures a false incident.
 */
function distinctSources(mentions: ClassifiedMention[]): number {
  const hosts = new Set<string>();
  for (const mention of mentions) {
    if (!mention.url) {
      hosts.add("canal");
      continue;
    }
    try {
      hosts.add(new URL(mention.url).host.toLowerCase().replace(/^www\./, ""));
    } catch {
      hosts.add(mention.url.trim().toLowerCase());
    }
  }
  return hosts.size;
}

function dateRange(mentions: ClassifiedMention[]) {
  const times = mentions
    .map((mention) => mention.published)
    .filter((value): value is string => Boolean(value))
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => a.time - b.time);

  return {
    mencion_mas_antigua: times[0]?.value,
    mencion_mas_reciente: times[times.length - 1]?.value,
  };
}

export function buildGroup(
  descripcion: string,
  mentions: ClassifiedMention[],
): MentionGroup {
  return {
    descripcion,
    menciones: mentions,
    fuentes_distintas: distinctSources(mentions),
    ...dateRange(mentions),
  };
}

export async function clusterMentions(
  mentions: ClassifiedMention[],
  { targetLanguage, complete = defaultComplete, signal }: ClusterOptions,
): Promise<ClusterResult> {
  if (mentions.length === 0) {
    return { grupos: [], reparaciones: [] };
  }

  // One mention cannot form a pattern, and asking the model to "group" it only
  // invites it to invent a theme.
  if (mentions.length === 1) {
    const only = mentions[0]!;
    return { grupos: [buildGroup(only.resumen, [only])], reparaciones: [] };
  }

  const raw = await complete({
    system: clusterSystemPrompt(targetLanguage),
    prompt: clusterUserPrompt(
      mentions.map(({ id, problema_nucleo, categoria, idioma_original }) => ({
        id,
        problema_nucleo,
        categoria,
        idioma_original,
      })),
    ),
    signal,
  });

  const parsed = clusterResponseSchema.parse(parseJsonResponse(raw));

  const byId = new Map(mentions.map((mention) => [mention.id, mention]));
  const assigned = new Set<string>();
  const reparaciones: string[] = [];
  const grupos: MentionGroup[] = [];

  for (const grupo of parsed.grupos) {
    const members: ClassifiedMention[] = [];
    for (const id of grupo.menciones) {
      const mention = byId.get(id);
      if (!mention) {
        // An id that was never in the input. Nothing to recover; note and drop.
        reparaciones.push(`unknown id "${id}" returned by clustering`);
        continue;
      }
      if (assigned.has(id)) {
        reparaciones.push(`mention "${id}" appeared in more than one group`);
        continue;
      }
      assigned.add(id);
      members.push(mention);
    }
    if (members.length > 0) {
      grupos.push(buildGroup(grupo.descripcion, members));
    }
  }

  // A mention the model forgot becomes its own group rather than disappearing.
  // Splitting is the safe direction, so this repair can only under-alert.
  for (const mention of mentions) {
    if (assigned.has(mention.id)) continue;
    reparaciones.push(`mention "${mention.id}" was left out and kept on its own`);
    grupos.push(buildGroup(mention.resumen, [mention]));
  }

  return { grupos, reparaciones };
}
