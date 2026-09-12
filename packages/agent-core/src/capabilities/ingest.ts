/**
 * The channel as an input, not just an output.
 *
 * This is the path that lets the project cover platforms whose APIs cost money:
 * a human finds the complaint and pastes it, the agent analyses it. Text pasted
 * straight into the channel comes through here too, so both team-supplied forms
 * arrive as the same kind of mention as a search result.
 *
 * The failure case is not an edge case. Plenty of platforms return a login wall,
 * a consent interstitial, or a 403 to anything without a browser session — that
 * is precisely why the team is pasting links in the first place. When retrieval
 * fails, this returns the failure. It never returns a guess, because a guess
 * about what a link "probably" says is indistinguishable from evidence once it
 * is inside a group.
 */
import { Exa } from "exa-js";
import type { RawMention } from "../classify";

export interface IngestSuccess {
  ok: true;
  mention: RawMention;
}

export interface IngestFailure {
  ok: false;
  url: string;
  reason: string;
  /** Written for the agent to relay, and it asks for the text instead. */
  message: string;
}

export type IngestResult = IngestSuccess | IngestFailure;

const MAX_TEXT = 4000;

function fail(url: string, reason: string): IngestFailure {
  return {
    ok: false,
    url,
    reason,
    message:
      `Could not retrieve the content of ${url} (${reason}). ` +
      `Do not describe or summarise this link — you have not read it, and its URL is not its contents. ` +
      `Ask the team to paste the text of the complaint directly into the channel instead; ` +
      `some platforms block access without a logged-in session.`,
  };
}

/**
 * Fetch a pasted URL through Exa's contents API, the same provider the search
 * sweep already uses, so there is one credential and one failure mode.
 */
export async function ingestUrl(
  url: string,
  options: { id?: string } = {},
): Promise<IngestResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail(url, "not a valid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return fail(url, `unsupported protocol ${parsed.protocol}`);
  }

  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    return fail(url, "no EXA_API_KEY configured, so links cannot be fetched");
  }

  // Let Exa's generic infer the shape — annotating the result erases the
  // options generic and `text` disappears from the type.
  let response;
  try {
    response = await new Exa(apiKey).getContents([parsed.toString()], {
      text: true,
    });
  } catch (error) {
    return fail(url, error instanceof Error ? error.message : String(error));
  }

  const result = response.results?.[0];
  const text = typeof result?.text === "string" ? result.text.trim() : "";
  if (!text) {
    return fail(url, "the page returned no readable text");
  }

  return {
    ok: true,
    mention: {
      id: options.id ?? parsed.toString(),
      text: text.slice(0, MAX_TEXT),
      origin: "canal",
      url: parsed.toString(),
      published: result?.publishedDate ?? undefined,
    },
  };
}

/**
 * A complaint someone typed or pasted with no link. There is nothing to fetch
 * and nothing that can fail — it is already the evidence.
 */
export function ingestText(
  text: string,
  options: { id?: string; published?: string } = {},
): IngestResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return fail("(pasted text)", "the pasted text was empty");
  }
  return {
    ok: true,
    mention: {
      id: options.id ?? `canal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: trimmed.slice(0, MAX_TEXT),
      origin: "canal",
      published: options.published,
    },
  };
}

/**
 * Mixed input: some links, some pasted text. Successes and failures come back
 * together so the agent can analyse what it has AND name what it could not read
 * — reporting only the successes would quietly shrink the evidence base.
 */
export async function ingestMany(
  items: { url?: string; text?: string; id?: string; published?: string }[],
): Promise<{ mentions: RawMention[]; failures: IngestFailure[] }> {
  const mentions: RawMention[] = [];
  const failures: IngestFailure[] = [];

  const results = await Promise.all(
    items.map(async (item): Promise<IngestResult> => {
      if (item.url) return ingestUrl(item.url, { id: item.id });
      if (item.text) {
        return ingestText(item.text, { id: item.id, published: item.published });
      }
      return fail("(empty item)", "neither a URL nor text was supplied");
    }),
  );

  for (const result of results) {
    if (result.ok) mentions.push(result.mention);
    else failures.push(result);
  }

  return { mentions, failures };
}
