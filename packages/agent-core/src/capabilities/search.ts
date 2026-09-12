/**
 * Grounded web search, surface-agnostic.
 *
 * Each surface wraps this in its own tool mechanism — `defineChannelTool` for
 * Channels, a server tool for the web app — so the implementation lives in one
 * place and the binding lives at the edge.
 */
import { Exa } from "exa-js";
import type { SearchHit, SearchWebArgs } from "../schemas";

/**
 * Exa search profiles are a latency dial, and the choice is not cosmetic:
 * `instant` ~250ms and `fast` ~450ms are the only sane options inside a chat
 * thread. `deep-reasoning` can take 40 seconds, which reads as a hung bot.
 */
const SEARCH_TYPE = (process.env.EXA_SEARCH_TYPE ?? "fast") as
  "instant" | "fast" | "auto" | "deep-lite" | "deep" | "deep-reasoning";

export function isSearchConfigured(): boolean {
  return Boolean(process.env.EXA_API_KEY);
}

/** The themes a complaint sweep has to cover; one query never covers all three. */
export type ComplaintTheme = "technical" | "billing" | "support";

export interface ComplaintQuery {
  query: string;
  /** ISO 639-1 code of the query's language. */
  language: string;
  theme: ComplaintTheme;
}

/**
 * Six queries per company: 3 English, 1 Spanish, 1 Portuguese, 1 German.
 *
 * Two things are deliberate here. First, the wording hunts for *users talking to
 * each other* — forum threads, subreddits, community posts — not press coverage
 * or the company's own marketing, which describe a company's reputation exactly
 * as the company wishes it were. Second, the themes rotate across languages, so
 * a Spanish-speaking billing problem is not invisible just because the Spanish
 * query happened to ask about bugs.
 *
 * The same complaint written in German and in Portuguese is one problem, not
 * two. That only becomes visible if you go looking in both.
 */
export function buildComplaintQueries(company: string): ComplaintQuery[] {
  const name = company.trim();
  if (!name) {
    throw new Error("A company name is required to build complaint queries.");
  }
  return [
    {
      language: "en",
      theme: "technical",
      query: `${name} users complaining on forums about bugs, errors, app not working or data loss`,
    },
    {
      language: "en",
      theme: "billing",
      query: `${name} customers complaining about being charged twice, unexpected fees, refund refused or cancellation still billed`,
    },
    {
      language: "en",
      theme: "support",
      query: `${name} customer support complaints: no response from support, account locked, ticket ignored`,
    },
    {
      language: "es",
      theme: "billing",
      query: `quejas de usuarios de ${name} en foros: cobro duplicado, no me devuelven el dinero, me siguen cobrando tras cancelar`,
    },
    {
      language: "pt",
      theme: "technical",
      query: `reclamações de usuários de ${name} em fóruns: aplicativo com erro, não consigo acessar, perdi meus dados`,
    },
    {
      language: "de",
      theme: "support",
      query: `${name} Nutzer beschweren sich im Forum: Support antwortet nicht, Konto gesperrt, Problem ungelöst`,
    },
  ];
}

/** A hit, plus which of the six queries turned it up. */
export interface ComplaintHit extends SearchHit {
  queryLanguage: string;
  theme: ComplaintTheme;
}

/**
 * Same URL reached from two queries is one mention. Normalising host case and a
 * trailing slash catches the ordinary duplicates without pretending that two
 * genuinely different pages on a forum are the same thread.
 */
function dedupeKey(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return url.trim();
  }
}

export interface ComplaintSweepArgs {
  company: string;
  /** Results per query, not in total. Six queries, so keep it small. */
  resultsPerQuery?: number;
}

/**
 * Run the six queries and merge them into one deduplicated list.
 *
 * A single query failing does not sink the sweep — that would make one flaky
 * language cost you the other five. Returning a plain string on an empty or
 * fully-failed sweep is what keeps the agent honest: it has something explicit
 * to report instead of an empty array it might paper over with guesses.
 */
export async function searchComplaints({
  company,
  resultsPerQuery = 5,
}: ComplaintSweepArgs): Promise<ComplaintHit[] | string> {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    return "Web search is not configured on this deployment (no EXA_API_KEY). Say so rather than guessing. You can still analyse complaints pasted into the channel.";
  }

  const queries = buildComplaintQueries(company);
  const exa = new Exa(apiKey);

  const settled = await Promise.allSettled(
    queries.map(async ({ query, language, theme }) => {
      const response = await exa.searchAndContents(query, {
        type: SEARCH_TYPE,
        numResults: resultsPerQuery,
        highlights: { numSentences: 2, highlightsPerUrl: 1 },
      });
      return response.results.map((hit) => ({
        title: hit.title ?? hit.url,
        url: hit.url,
        published: hit.publishedDate ?? undefined,
        highlight: hit.highlights?.[0],
        queryLanguage: language,
        theme,
      }));
    }),
  );

  const failures = settled.filter((outcome) => outcome.status === "rejected");
  if (failures.length === queries.length) {
    const [first] = failures;
    const reason =
      first && first.status === "rejected" ? String(first.reason) : "unknown error";
    return `All ${queries.length} searches failed, so no mentions were retrieved from the web: ${reason}. Report this plainly; do not substitute assumed complaints.`;
  }

  const seen = new Set<string>();
  const hits: ComplaintHit[] = [];
  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") continue;
    for (const hit of outcome.value) {
      const key = dedupeKey(hit.url);
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(hit);
    }
  }

  if (hits.length === 0) {
    return `The ${queries.length} complaint searches for "${company}" returned no results. Say that the open-web sweep found nothing and ask the team to paste anything they have seen; do not invent mentions.`;
  }

  // Note for the caller: partial failures are silent by design, but the count of
  // languages actually covered is visible in the hits themselves.
  return hits;
}

export async function searchWeb({ query, results }: SearchWebArgs): Promise<SearchHit[] | string> {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    return "Web search is not configured on this deployment (no EXA_API_KEY). Say so rather than guessing.";
  }

  const exa = new Exa(apiKey);
  const response = await exa.searchAndContents(query, {
    type: SEARCH_TYPE,
    numResults: results,
    highlights: { numSentences: 2, highlightsPerUrl: 1 },
  });

  return response.results.map((hit) => ({
    title: hit.title ?? hit.url,
    url: hit.url,
    published: hit.publishedDate ?? undefined,
    highlight: hit.highlights?.[0],
  }));
}
