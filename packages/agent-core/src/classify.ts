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
  /**
   * How many mentions to classify at once.
   *
   * Classification is one independent call per mention, so the naive version
   * fires all of them simultaneously — and a new or free provider account,
   * commonly capped near 20 requests per minute, rejects the whole burst. A
   * small pool keeps a 30-mention sweep inside those limits. Raise it when the
   * account's limits are higher; the work is embarrassingly parallel.
   */
  concurrency?: number;
}

const DEFAULT_CONCURRENCY = 3;

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
  const limit = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const settled: PromiseSettledResult<ClassifiedMention>[] = new Array(mentions.length);

  // A fixed pool of workers pulling from a shared cursor: steady pressure on the
  // provider instead of one burst, and a slow mention never blocks the others
  // the way fixed-size batches would.
  let cursor = 0;
  const worker = async () => {
    while (cursor < mentions.length) {
      const index = cursor++;
      const mention = mentions[index]!;
      try {
        settled[index] = { status: "fulfilled", value: await classifyMention(mention, options) };
      } catch (reason) {
        settled[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, mentions.length) }, worker));

  const classified: ClassifiedMention[] = [];
  const failures: { id: string; reason: string }[] = [];

  settled.forEach((outcome, index) => {
    if (outcome?.status === "fulfilled") {
      classified.push(outcome.value);
    } else {
      failures.push({
        id: mentions[index]!.id,
        reason: String(outcome?.reason ?? "unknown failure"),
      });
    }
  });

  return { classified, failures };
}
