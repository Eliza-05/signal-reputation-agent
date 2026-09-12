/**
 * The query builder is pure, so it can be pinned exactly. The sweep itself
 * needs an Exa account and is checked live, not here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildComplaintQueries, searchComplaints } from "./search";

describe("buildComplaintQueries", () => {
  const queries = buildComplaintQueries("Acme");

  it("covers four languages in the documented proportions", () => {
    assert.equal(queries.length, 6);
    const byLanguage = queries.reduce<Record<string, number>>((counts, query) => {
      counts[query.language] = (counts[query.language] ?? 0) + 1;
      return counts;
    }, {});
    assert.deepEqual(byLanguage, { en: 3, es: 1, pt: 1, de: 1 });
  });

  it("covers all three themes, so one kind of complaint is never invisible", () => {
    const themes = new Set(queries.map((query) => query.theme));
    assert.deepEqual([...themes].sort(), ["billing", "support", "technical"]);
  });

  it("spreads themes across languages rather than stacking them in English", () => {
    // If every non-English query asked about bugs, a Spanish-speaking billing
    // problem would simply never be found.
    const nonEnglish = queries.filter((query) => query.language !== "en");
    assert.equal(new Set(nonEnglish.map((query) => query.theme)).size, 3);
  });

  it("puts the company name in every query", () => {
    for (const query of queries) {
      assert.ok(query.query.includes("Acme"), `missing company: ${query.query}`);
    }
  });

  it("hunts for users talking to each other, not for press coverage", () => {
    const text = queries.map((query) => query.query.toLowerCase()).join(" ");
    for (const word of ["forum", "foros", "fóruns", "forum"]) {
      assert.ok(text.includes(word), `expected community wording: ${word}`);
    }
    for (const banned of ["press release", "news", "investor"]) {
      assert.ok(!text.includes(banned), `should not chase ${banned}`);
    }
  });

  it("refuses an empty company name rather than searching for nothing", () => {
    assert.throws(() => buildComplaintQueries("   "), /company name is required/i);
  });
});

describe("searchComplaints", () => {
  it("reports the missing credential instead of throwing", async (t) => {
    // The channel half of the evidence still works without Exa, so this must
    // degrade into something the agent can say out loud.
    const previous = process.env.EXA_API_KEY;
    delete process.env.EXA_API_KEY;
    t.after(() => {
      if (previous !== undefined) process.env.EXA_API_KEY = previous;
    });

    const result = await searchComplaints({ company: "Acme" });
    assert.equal(typeof result, "string");
    assert.match(String(result), /EXA_API_KEY/);
    assert.match(String(result), /pasted into the channel/i);
  });
});
