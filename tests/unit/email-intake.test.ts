import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { isSenderAllowed, verifyHmac, normalizeMime } from "../../src/email-intake.js";

describe("isSenderAllowed", () => {
  const allowlist = "billing@rvfb.org,@charlies-produce.com,*@carusos.com";

  it("matches exact addresses case-insensitively", () => {
    assert.equal(isSenderAllowed("billing@rvfb.org", allowlist), true);
    assert.equal(isSenderAllowed("BILLING@RVFB.ORG", allowlist), true);
    assert.equal(isSenderAllowed("someone-else@rvfb.org", allowlist), false);
  });

  it("matches domain patterns (@domain and *@domain equivalently)", () => {
    assert.equal(isSenderAllowed("ap@charlies-produce.com", allowlist), true);
    assert.equal(isSenderAllowed("ap@CARUSOS.com", allowlist), true);
    assert.equal(isSenderAllowed("attacker@evil.com", allowlist), false);
  });

  it("parses `Name <addr>` format", () => {
    assert.equal(isSenderAllowed("Charlie's AP <ap@charlies-produce.com>", allowlist), true);
    assert.equal(isSenderAllowed("Fake Charlie's <ap@charlies-fake.com>", allowlist), false);
  });

  it("fail-closed on empty allowlist", () => {
    assert.equal(isSenderAllowed("billing@rvfb.org", ""), false);
    assert.equal(isSenderAllowed("billing@rvfb.org", "   "), false);
  });

  it("rejects malformed addresses", () => {
    assert.equal(isSenderAllowed("not an email", allowlist), false);
    assert.equal(isSenderAllowed("ap @charlies-produce.com", allowlist), false);
    assert.equal(isSenderAllowed("", allowlist), false);
  });

  it("does not match subdomain via the *@ pattern", () => {
    // *@carusos.com should NOT match ap@sub.carusos.com — CF/DKIM would flag
    // that as a distinct sending domain and we want to fail closed.
    assert.equal(isSenderAllowed("ap@sub.carusos.com", allowlist), false);
  });
});

describe("verifyHmac", () => {
  const secret = "test-secret-abcdefghijklmnop";
  const body = Buffer.from('{"messageId":"<abc@x>","from":"a@b.c","attachments":[]}');
  const goodSig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a matching signature", () => {
    assert.equal(verifyHmac(body, goodSig, secret), true);
  });

  it("accepts a signature without the sha256= prefix", () => {
    const bare = goodSig.slice("sha256=".length);
    assert.equal(verifyHmac(body, bare, secret), true);
  });

  it("rejects a signature computed with a different secret", () => {
    const badSig = "sha256=" + createHmac("sha256", "wrong-secret").update(body).digest("hex");
    assert.equal(verifyHmac(body, badSig, secret), false);
  });

  it("rejects a signature over a different body", () => {
    const otherSig = "sha256=" + createHmac("sha256", secret).update(Buffer.from("different")).digest("hex");
    assert.equal(verifyHmac(body, otherSig, secret), false);
  });

  it("rejects missing signature", () => {
    assert.equal(verifyHmac(body, undefined, secret), false);
    assert.equal(verifyHmac(body, "", secret), false);
  });

  it("rejects signatures of the wrong length without throwing", () => {
    assert.equal(verifyHmac(body, "sha256=deadbeef", secret), false);
    assert.equal(verifyHmac(body, "sha256=", secret), false);
    assert.equal(verifyHmac(body, "not-hex-at-all", secret), false);
  });
});

describe("normalizeMime", () => {
  it("passes through canonical accepted MIMEs", () => {
    assert.equal(normalizeMime("application/pdf", "invoice.pdf"), "application/pdf");
    assert.equal(normalizeMime("image/jpeg", "photo.jpg"), "image/jpeg");
    assert.equal(normalizeMime("image/png", "signature.png"), "image/png");
    assert.equal(normalizeMime("IMAGE/PNG", "shout.png"), "IMAGE/PNG");
  });

  it("coerces application/octet-stream to canonical MIME by filename ext", () => {
    // Outlook-forwarded PDFs frequently arrive as octet-stream.
    assert.equal(normalizeMime("application/octet-stream", "INVOICE-00603761.pdf"), "application/pdf");
    assert.equal(normalizeMime("application/octet-stream", "receipt.jpeg"), "image/jpeg");
    assert.equal(normalizeMime("application/octet-stream", "receipt.JPG"), "image/jpeg");
    assert.equal(normalizeMime("application/x-pdf", "invoice.pdf"), "application/pdf");
  });

  it("falls back on empty MIME if filename is known-good", () => {
    assert.equal(normalizeMime("", "invoice.pdf"), "application/pdf");
    assert.equal(normalizeMime("", "photo.heic"), "image/heic");
  });

  it("rejects when both MIME is unusable and filename ext is not accepted", () => {
    assert.equal(normalizeMime("application/octet-stream", "invoice.doc"), null);
    assert.equal(normalizeMime("text/plain", "note.txt"), null);
    assert.equal(normalizeMime("", "attachment"), null);
    assert.equal(normalizeMime("", ""), null);
  });
});
