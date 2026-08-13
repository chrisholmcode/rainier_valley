import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseVendorConfig,
  matchesPattern,
  computeVendorStatuses,
  computePipeAgeDays,
  type VendorRule
} from "../../src/email-heartbeat.js";
import type { ProcessedEmailLogEntry, ProcessedEmailResult } from "../../src/sheets.js";

function row(from: string, receivedAt: string, result: ProcessedEmailResult = "processed"): ProcessedEmailLogEntry {
  return {
    receivedAt,
    messageId: `<${receivedAt}@x>`,
    from,
    subject: "",
    attachmentFilename: "invoice.pdf",
    attachmentSha256: "0".repeat(64),
    result,
    supplier: null,
    invoiceOrOrderNumber: null,
    rowsAdded: result === "processed" ? 3 : 0,
    photoUrl: null,
    error: null
  };
}

describe("parseVendorConfig", () => {
  it("parses a normal CSV", () => {
    const rules = parseVendorConfig("@charlies-produce.com:10,@carusos.com:14");
    assert.deepEqual(rules, [
      { pattern: "@charlies-produce.com", staleDays: 10 },
      { pattern: "@carusos.com", staleDays: 14 }
    ]);
  });

  it("lowercases patterns and trims whitespace", () => {
    const rules = parseVendorConfig(" Billing@RVFB.org : 7 , *@CHARLIES-produce.com:10 ");
    assert.equal(rules[0].pattern, "billing@rvfb.org");
    assert.equal(rules[0].staleDays, 7);
    assert.equal(rules[1].pattern, "*@charlies-produce.com");
  });

  it("skips empty CSV entries", () => {
    const rules = parseVendorConfig("@a.com:1,,@b.com:2,");
    assert.equal(rules.length, 2);
  });

  it("throws on missing days", () => {
    assert.throws(() => parseVendorConfig("@a.com"), /missing ":days"/);
  });

  it("throws on non-positive or non-numeric days", () => {
    assert.throws(() => parseVendorConfig("@a.com:0"), /non-positive days/);
    assert.throws(() => parseVendorConfig("@a.com:-1"), /non-positive days/);
    assert.throws(() => parseVendorConfig("@a.com:xyz"), /non-positive days/);
  });
});

describe("matchesPattern", () => {
  it("supports exact, @domain, and *@domain patterns", () => {
    assert.equal(matchesPattern("ap@charlies-produce.com", "@charlies-produce.com"), true);
    assert.equal(matchesPattern("ap@charlies-produce.com", "*@charlies-produce.com"), true);
    assert.equal(matchesPattern("billing@rvfb.org", "billing@rvfb.org"), true);
    assert.equal(matchesPattern("someone@rvfb.org", "billing@rvfb.org"), false);
  });

  it("unwraps `Name <addr>` format", () => {
    assert.equal(matchesPattern('"Charlie AP" <ap@charlies-produce.com>', "@charlies-produce.com"), true);
  });

  it("is case-insensitive", () => {
    assert.equal(matchesPattern("AP@Charlies-Produce.COM", "@charlies-produce.com"), true);
  });
});

describe("computeVendorStatuses", () => {
  const rules: VendorRule[] = [
    { pattern: "@charlies-produce.com", staleDays: 10 },
    { pattern: "@carusos.com", staleDays: 14 }
  ];
  const now = new Date("2026-08-11T12:00:00Z");

  it("returns lastReceivedAt=null when a vendor is not in the rows", () => {
    const statuses = computeVendorStatuses(rules, [], now);
    assert.equal(statuses[0].lastReceivedAt, null);
    assert.equal(statuses[0].daysSinceLastReceived, null);
    // isStale is false for "never seen" — caller must decide whether to alert
    // based on whether the tab is empty vs non-empty.
    assert.equal(statuses[0].isStale, false);
  });

  it("picks the most recent row per vendor across mixed history", () => {
    const rows: ProcessedEmailLogEntry[] = [
      row("ap@charlies-produce.com", "2026-08-01T09:00:00Z"),
      row("ap@charlies-produce.com", "2026-08-10T09:00:00Z"),   // most recent charlies
      row("ap@charlies-produce.com", "2026-08-05T09:00:00Z"),
      row("ar@carusos.com", "2026-07-20T09:00:00Z")             // most recent carusos
    ];
    const statuses = computeVendorStatuses(rules, rows, now);
    assert.equal(statuses[0].lastReceivedAt?.toISOString(), "2026-08-10T09:00:00.000Z");
    assert.equal(statuses[0].isStale, false); // 1.1 days < 10
    assert.equal(statuses[1].lastReceivedAt?.toISOString(), "2026-07-20T09:00:00.000Z");
    assert.equal(statuses[1].isStale, true);  // ~22 days > 14
  });

  it("counts non-processed rows (dedup, extraction_failed) as pipe-alive signals", () => {
    // The heartbeat is asking 'did the mail arrive,' not 'did extraction work.'
    const rows: ProcessedEmailLogEntry[] = [
      row("ap@charlies-produce.com", "2026-08-10T09:00:00Z", "extraction_failed"),
      row("ap@charlies-produce.com", "2026-08-09T09:00:00Z", "dedup_message_id"),
      row("ap@charlies-produce.com", "2026-07-01T09:00:00Z", "processed")
    ];
    const [charlies] = computeVendorStatuses([rules[0]], rows, now);
    assert.equal(charlies.lastReceivedAt?.toISOString(), "2026-08-10T09:00:00.000Z");
    assert.equal(charlies.isStale, false);
  });

  it("flags stale exactly at the boundary as still-fresh, past-boundary as stale", () => {
    const [charlies] = computeVendorStatuses(
      [rules[0]],
      [row("ap@charlies-produce.com", "2026-08-01T12:00:00Z")], // exactly 10 days ago
      now
    );
    assert.equal(charlies.daysSinceLastReceived, 10);
    // Strictly > threshold, so 10 == 10 is still-fresh.
    assert.equal(charlies.isStale, false);

    const [past] = computeVendorStatuses(
      [rules[0]],
      [row("ap@charlies-produce.com", "2026-08-01T11:00:00Z")], // 10.04 days
      now
    );
    assert.equal(past.isStale, true);
  });

  it("ignores rows with unparseable receivedAt", () => {
    const rows: ProcessedEmailLogEntry[] = [
      row("ap@charlies-produce.com", "not-a-date"),
      row("ap@charlies-produce.com", "2026-08-10T09:00:00Z")
    ];
    const [charlies] = computeVendorStatuses([rules[0]], rows, now);
    assert.equal(charlies.lastReceivedAt?.toISOString(), "2026-08-10T09:00:00.000Z");
  });

  it("does not match rows whose `from` fails the pattern", () => {
    const rows: ProcessedEmailLogEntry[] = [
      row("attacker@evil.com", "2026-08-10T09:00:00Z"),
      row("noreply@charlies-produce.com.evil.com", "2026-08-10T09:00:00Z")
    ];
    const [charlies] = computeVendorStatuses([rules[0]], rows, now);
    assert.equal(charlies.lastReceivedAt, null);
  });
});

describe("computePipeAgeDays", () => {
  const now = new Date("2026-08-13T12:00:00Z");

  it("returns null for an empty tab", () => {
    assert.equal(computePipeAgeDays([], now), null);
  });

  it("measures from the oldest row's receivedAt regardless of vendor", () => {
    const rows: ProcessedEmailLogEntry[] = [
      row("someone@anything.com", "2026-08-11T12:00:00Z"), // 2d ago — oldest
      row("ap@charlies-produce.com", "2026-08-12T09:00:00Z"),
      row("billing@rvfb.org", "2026-08-13T09:00:00Z")
    ];
    assert.equal(computePipeAgeDays(rows, now), 2);
  });

  it("ignores rows with unparseable receivedAt", () => {
    const rows: ProcessedEmailLogEntry[] = [
      row("ap@charlies-produce.com", "not-a-date"),
      row("ap@charlies-produce.com", "2026-08-10T12:00:00Z")
    ];
    assert.equal(computePipeAgeDays(rows, now), 3);
  });

  it("returns null when every row has an unparseable receivedAt", () => {
    const rows: ProcessedEmailLogEntry[] = [
      row("ap@charlies-produce.com", "garbage"),
      row("ar@carusos.com", "also-garbage")
    ];
    assert.equal(computePipeAgeDays(rows, now), null);
  });
});
