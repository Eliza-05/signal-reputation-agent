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
  /** Pin the query to these hosts. Guarantees a source outside the vendor. */
  includeDomains?: string[];
  /** Keep the query away from these hosts. Used to push past the vendor forum. */
  excludeDomains?: string[];
}

/** Third-party review sites: the customer's side of the story, not the vendor's. */
const REVIEW_SITES = [
  "trustpilot.com",
  "g2.com",
  "capterra.com",
  "getapp.com",
  "sitejabber.com",
];

/** General communities, where people complain without the vendor moderating. */
const COMMUNITY_SITES = [
  "reddit.com",
  "news.ycombinator.com",
  "quora.com",
  "stackoverflow.com",
];

/**
 * Guess the vendor's own domain from its name — "Zapier" → "zapier.com".
 *
 * A heuristic, and deliberately a cheap one: a wrong guess excludes a domain
 * that was never going to appear, which costs nothing. A right guess is what
 * stops the whole sweep collapsing onto the vendor's own support forum.
 */
export function vendorDomains(company: string): string[] {
  const slug = company
    .normalize("NFD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return slug ? [`${slug}.com`] : [];
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
  const vendor = vendorDomains(name);
  return [
    // Pinned off-vendor. Without these the sweep lands entirely on the
    // company's own community forum: semantic search matches the densest
    // page about a product, and that is always the vendor's own support site.
    {
      language: "en",
      theme: "technical",
      query: `${name} bugs, errors, app not working or data loss — users complaining`,
      includeDomains: COMMUNITY_SITES,
    },
    {
      language: "en",
      theme: "billing",
      query: `${name} review: charged twice, unexpected fees, refund refused, cancelled but still billed`,
      includeDomains: REVIEW_SITES,
    },
    // One unrestricted query. The vendor's forum carries real complaints and
    // should not be banned outright — it just must not be the only source.
    {
      language: "en",
      theme: "support",
      query: `${name} customer support complaints: no response from support, account locked, ticket ignored`,
    },
    // Non-English, pushed off the vendor domain. The vendor forum is almost
    // entirely English, so leaving it in returns English posts for a Spanish
    // query — which looks like multilingual coverage while delivering none.
    {
      language: "es",
      theme: "billing",
      query: `opiniones y quejas sobre ${name}: cobro duplicado, no me devuelven el dinero, me siguen cobrando tras cancelar`,
      excludeDomains: vendor,
    },
    {
      language: "pt",
      theme: "technical",
      query: `reclamações sobre ${name} em fóruns: aplicativo com erro, não consigo acessar, perdi meus dados`,
      excludeDomains: vendor,
    },
    {
      language: "de",
      theme: "support",
      query: `${name} Erfahrungen und Beschwerden: Support antwortet nicht, Konto gesperrt, Problem ungelöst`,
      excludeDomains: vendor,
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
  /**
   * Results per query, not in total. There are six queries, and every hit
   * becomes one model call in classification, so this number multiplies by six
   * into the provider's rate limit. At 2 a full sweep stays near a dozen
   * mentions, which fits inside the ~20 requests per minute that new and free
   * accounts allow. Raise it when the account's limits are higher — more
   * mentions is strictly better evidence.
   */
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
  resultsPerQuery = 2,
}: ComplaintSweepArgs): Promise<ComplaintHit[] | string> {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    return "Web search is not configured on this deployment (no EXA_API_KEY). Say so rather than guessing. You can still analyse complaints pasted into the channel.";
  }

  const queries = buildComplaintQueries(company);
  const exa = new Exa(apiKey);

  const settled = await Promise.allSettled(
    queries.map(async ({ query, language, theme, includeDomains, excludeDomains }) => {
      const response = await exa.searchAndContents(query, {
        type: SEARCH_TYPE,
        numResults: resultsPerQuery,
        highlights: { numSentences: 2, highlightsPerUrl: 1 },
        ...(includeDomains?.length ? { includeDomains } : {}),
        ...(excludeDomains?.length ? { excludeDomains } : {}),
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
