/**
 * The query builder is pure, so it can be pinned exactly. The sweep itself
 * needs an Exa account and is checked live, not here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildComplaintQueries, searchComplaints, vendorDomains } from "./search";

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

  it("does not chase press coverage or investor material", () => {
    const text = queries.map((query) => query.query.toLowerCase()).join(" ");
    for (const banned of ["press release", "investor", "funding round"]) {
      assert.ok(!text.includes(banned), `should not chase ${banned}`);
    }
  });

  it("pins queries to sources outside the vendor, rather than hoping wording does it", () => {
    // Wording alone put 100% of a real Zapier sweep on community.zapier.com:
    // semantic search matches the densest page about a product, which is always
    // the vendor's own support forum. Domain filters are the actual guarantee.
    const pinned = queries.filter((query) => query.includeDomains?.length);
    assert.ok(pinned.length >= 2, "at least two queries must be pinned off-vendor");
    for (const query of pinned) {
      for (const domain of query.includeDomains!) {
        assert.ok(
          !domain.includes("acme"),
          `pinned domain ${domain} must not be the vendor's own`,
        );
      }
    }
  });

  it("keeps non-English queries off the vendor's English-only forum", () => {
    // Left unrestricted, a Spanish query returns English posts from the vendor
    // forum — multilingual coverage on paper, none in practice.
    for (const query of queries.filter((q) => q.language !== "en")) {
      assert.ok(
        query.excludeDomains?.includes("acme.com"),
        `${query.language} query must exclude the vendor domain`,
      );
    }
  });

  it("leaves one query unrestricted, so the vendor forum is not banned outright", () => {
    // The vendor's forum carries real complaints. It must not be the only
    // source, but excluding it everywhere would throw away genuine evidence.
    const open = queries.filter(
      (query) => !query.includeDomains?.length && !query.excludeDomains?.length,
    );
    assert.ok(open.length >= 1, "at least one query must search the open web");
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

describe("vendorDomains", () => {
  it("derives the vendor host from the company name", () => {
    assert.deepEqual(vendorDomains("Zapier"), ["zapier.com"]);
    assert.deepEqual(vendorDomains("  Acme  "), ["acme.com"]);
  });

  it("strips accents and punctuation rather than producing an invalid host", () => {
    assert.deepEqual(vendorDomains("Café Möbel"), ["cafemobel.com"]);
  });

  it("returns nothing when the name has no usable characters", () => {
    // A wrong or empty guess must exclude nothing, never everything.
    assert.deepEqual(vendorDomains("!!!"), []);
  });
});
