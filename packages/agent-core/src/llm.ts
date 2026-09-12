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

export const complete: CompleteFn = async ({ system, prompt, signal }) => {
  const { text } = await generateText({
    model: resolveLanguageModel(),
    system,
    prompt,
    abortSignal: signal,
  });
  return text;
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
