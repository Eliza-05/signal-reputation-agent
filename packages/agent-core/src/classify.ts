/**
 * Turn a raw mention into a structured, translated, scored record.
 *
 * The prompt lives in `prompts/classify.ts` so it can be tuned without touching
 * this file. What lives here is the contract: the schema, the parsing, and the
 * decisions the model is not allowed to make.
 */
import { z } from "zod";
import { complete as defaultComplete, parseJsonResponse, type CompleteFn } from "./llm";
import {
  CATEGORIES,
  PRIORITIES,
  classifySystemPrompt,
  classifyUserPrompt,
} from "./prompts/classify";

export const ORIGINS = ["busqueda", "canal"] as const;
export type MentionOrigin = (typeof ORIGINS)[number];

export const mentionClassificationSchema = z.object({
  resumen: z.string().min(1),
  idioma_original: z.string().min(2).max(8),
  categoria: z.enum(CATEGORIES),
  prioridad: z.enum(PRIORITIES),
  problema_nucleo: z.string().min(1),
  es_queja: z.boolean(),
  origen: z.enum(ORIGINS),
});

export type MentionClassification = z.infer<typeof mentionClassificationSchema>;

/** A mention before analysis, from either source. */
export interface RawMention {
  /** Stable within one run; clustering and the cards refer back to it. */
  id: string;
  text: string;
  origin: MentionOrigin;
  /** Absent for text a teammate typed straight into the channel. */
  url?: string;
  /** ISO timestamp when known. Recency drives the incident test. */
  published?: string;
}

export interface ClassifiedMention extends MentionClassification {
  id: string;
  text: string;
  url?: string;
  published?: string;
}

export interface ClassifyOptions {
  /** Language every human-readable field comes back in. */
  targetLanguage: string;
  /** Injected in tests so they never need a model or a network. */
  complete?: CompleteFn;
  signal?: AbortSignal;
}

export async function classifyMention(
  mention: RawMention,
  { targetLanguage, complete = defaultComplete, signal }: ClassifyOptions,
): Promise<ClassifiedMention> {
  const raw = await complete({
    system: classifySystemPrompt(targetLanguage),
    prompt: classifyUserPrompt({
      text: mention.text,
      origin: mention.origin,
      sourceUrl: mention.url,
    }),
    signal,
  });

  const parsed = mentionClassificationSchema.parse(parseJsonResponse(raw));

  return {
    ...parsed,
    // Origin is a fact about how we obtained the mention, not a judgement call.
    // The model is told it, and told not to change it; this makes that true
    // rather than merely requested.
    origen: mention.origin,
    id: mention.id,
    text: mention.text,
    url: mention.url,
    published: mention.published,
  };
}

export interface ClassifyBatchResult {
  classified: ClassifiedMention[];
  /** Mentions the model could not return valid JSON for. Reported, not hidden. */
  failures: { id: string; reason: string }[];
}

/**
 * One bad mention must not sink the batch, and a failed mention must not
 * quietly vanish either — the caller gets both lists and says so in the thread.
 */
export async function classifyMentions(
  mentions: RawMention[],
  options: ClassifyOptions,
): Promise<ClassifyBatchResult> {
  const settled = await Promise.allSettled(
    mentions.map((mention) => classifyMention(mention, options)),
  );

  const classified: ClassifiedMention[] = [];
  const failures: { id: string; reason: string }[] = [];

  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") {
      classified.push(outcome.value);
    } else {
      failures.push({
        id: mentions[index]!.id,
        reason: String(outcome.reason),
      });
    }
  });

  return { classified, failures };
}
