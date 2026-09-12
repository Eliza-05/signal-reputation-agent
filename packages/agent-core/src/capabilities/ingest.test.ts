/**
 * The failure path is the point of this module, so it is what gets tested.
 * Plenty of platforms return a login wall to anything without a browser
 * session — that is precisely why the team is pasting links in the first place.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ingestText, ingestUrl, ingestMany } from "./ingest";

describe("ingestText", () => {
  it("turns pasted text into a channel mention with no fetching involved", () => {
    const result = ingestText("Me cobraron dos veces tras cancelar", { id: "c1" });
    assert.ok(result.ok);
    assert.equal(result.mention.origin, "canal");
    assert.equal(result.mention.id, "c1");
    assert.equal(result.mention.url, undefined);
    assert.match(result.mention.text, /cobraron dos veces/);
  });

  it("generates an id when none is supplied", () => {
    const result = ingestText("una queja");
    assert.ok(result.ok);
    assert.ok(result.mention.id.startsWith("canal-"));
  });

  it("rejects empty text instead of creating a blank mention", () => {
    const result = ingestText("   ");
    assert.equal(result.ok, false);
  });
});

describe("ingestUrl", () => {
  it("fails without inventing anything about the link", async () => {
    const result = await ingestUrl("https://x.example/not-fetchable");
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    // The message must push toward the real remedy — paste the text — and must
    // forbid describing a page nobody read.
    assert.match(result.message, /Do not describe or summarise this link/i);
    assert.match(result.message, /paste the text/i);
    assert.match(result.message, /its URL is not its contents/i);
  });

  it("rejects a non-URL", async () => {
    const result = await ingestUrl("no soy una url");
    assert.ok(!result.ok);
    assert.match(result.reason, /not a valid URL/);
  });

  it("rejects a non-HTTP scheme", async () => {
    const result = await ingestUrl("file:///etc/passwd");
    assert.ok(!result.ok);
    assert.match(result.reason, /unsupported protocol/);
  });
});

describe("ingestMany", () => {
  it("returns successes and failures together, never just the successes", async () => {
    // Reporting only what worked would quietly shrink the evidence base, which
    // is the same class of error as inventing a source.
    const { mentions, failures } = await ingestMany([
      { text: "queja pegada a mano" },
      { url: "https://x.example/blocked" },
      { text: "otra queja" },
    ]);

    assert.equal(mentions.length, 2);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.url, "https://x.example/blocked");
  });

  it("flags an item that is neither text nor a link", async () => {
    const { mentions, failures } = await ingestMany([{}]);
    assert.equal(mentions.length, 0);
    assert.equal(failures.length, 1);
  });
});
