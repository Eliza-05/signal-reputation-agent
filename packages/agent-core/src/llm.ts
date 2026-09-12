/**
 * A plain text completion, for the steps that are not the conversational agent.
 *
 * Classification and clustering are not conversations — they are one input, one
 * strictly-shaped answer, no tools, no history. Running them through the channel
 * agent would put them at the mercy of the conversation's context and cost a
 * full agent turn each. So they call the model directly.
 *
 * `resolveModel()` stays the single source of truth for reading the environment;
 * this only adapts its result into an AI SDK model instance. The kit's Slack
 * template documents openai and openrouter, and those are the two supported
 * here — anthropic and google would need SDK packages this workspace does not
 * install, so they fail loudly rather than at the first request.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, type LanguageModel } from "ai";
import { resolveModel } from "./model";

export function resolveLanguageModel(): LanguageModel {
  const resolved = resolveModel();

  // The OpenRouter branch of resolveModel already hands back a model instance.
  if (typeof resolved !== "string") return resolved;

  const separator = resolved.indexOf(":");
  const provider = resolved.slice(0, separator);
  const modelId = resolved.slice(separator + 1);

  if (provider !== "openai") {
    throw new Error(
      `Analysis steps support MODEL_PROVIDER=openai or openrouter; got '${provider}'. ` +
        `Change MODEL_PROVIDER in the root .env, or add that provider's AI SDK package.`,
    );
  }

  return createOpenAI({ apiKey: process.env.OPENAI_API_KEY! })(modelId);
}

/** What every analysis step needs from a model: text in, text out. */
export type CompleteFn = (input: {
  system: string;
  prompt: string;
  signal?: AbortSignal;
}) => Promise<string>;

/**
 * A rate-limited provider is not a broken one — it is a provider asking us to
 * slow down. Free and new accounts are commonly capped around 20 requests per
 * minute, and this pipeline classifies every mention independently, so a burst
 * is the normal case rather than the exception.
 *
 * Retrying is what keeps that from surfacing as "Something went wrong" in a
 * Slack thread. Anything that is not a rate limit is thrown immediately: a bad
 * key or a wrong model slug will not fix itself, and retrying it just makes the
 * user wait longer for the same error.
 */
const RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BASE_DELAY_MS = 4_000;

function isRateLimit(error: unknown): boolean {
  const status = (error as { statusCode?: number; status?: number } | null)?.statusCode ??
    (error as { status?: number } | null)?.status;
  if (status === 429) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /rate limit|429|too many requests/i.test(message);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Aborted while waiting out a rate limit."));
      },
      { once: true },
    );
  });

export const complete: CompleteFn = async ({ system, prompt, signal }) => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt += 1) {
    try {
      const { text } = await generateText({
        model: resolveLanguageModel(),
        system,
        prompt,
        abortSignal: signal,
      });
      return text;
    } catch (error) {
      lastError = error;
      if (!isRateLimit(error) || attempt === RATE_LIMIT_RETRIES) throw error;
      // Exponential backoff with jitter, so retries from a batch that was
      // throttled together do not all come back at the same instant and
      // throttle each other again.
      const delay = RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt + Math.random() * 1_000;
      await sleep(delay, signal);
    }
  }
  throw lastError;
};

/**
 * Models are told to return bare JSON and mostly do, but "mostly" is not a
 * parser. Strip a fenced block if one shows up, then fall back to the outermost
 * braces. Anything still unparseable is a real failure and is thrown as one —
 * a silently-defaulted classification is worse than a missing mention.
 */
export function parseJsonResponse(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error(
      `Model did not return parseable JSON. First 200 characters: ${candidate.slice(0, 200)}`,
    );
  }
}
