import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  isSenderAllowed,
  verifyHmac,
  normalizeMime,
  decodeSrsAddress,
  labelOpaqueSrsBounce,
  resolveOriginalSender
} from "../../src/email-intake.js";

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

describe("decodeSrsAddress", () => {
  it("decodes plaintext SRS0/SRS1/bounces+SRS envelopes to local@domain", () => {
    assert.equal(
      decodeSrsAddress("SRS0=HHH=TT=charliesproduce.com=orders@forwarder.com"),
      "orders@charliesproduce.com"
    );
    assert.equal(
      decodeSrsAddress("SRS1=XXX=hop==HHH=TT=carusos.com=ap@relay.net"),
      "ap@carusos.com"
    );
    assert.equal(
      decodeSrsAddress("bounces+SRS=HHH=TT=charlies-produce.com=ap@gmail.com"),
      "ap@charlies-produce.com"
    );
  });

  it("returns null for opaque SRS bounces with no plaintext sender", () => {
    assert.equal(decodeSrsAddress("bounces+SRS=vAN5T=H5@rvfb.org"), null);
    assert.equal(decodeSrsAddress("plain-address@example.com"), null);
  });
});

describe("labelOpaqueSrsBounce", () => {
  it("labels opaque SRS envelopes with the forwarder domain", () => {
    assert.equal(labelOpaqueSrsBounce("bounces+SRS=vAN5T=H5@rvfb.org"), "forwarded-via@rvfb.org");
  });
  it("returns null for addresses that aren't SRS at all", () => {
    assert.equal(labelOpaqueSrsBounce("ap@charlies.com"), null);
  });
});

describe("resolveOriginalSender", () => {
  it("prefers Reply-To over everything else", () => {
    assert.equal(
      resolveOriginalSender({
        from: "bounces+SRS=vAN5T=H5@rvfb.org",
        replyTo: "ap@charlies-produce.com"
      }),
      "ap@charlies-produce.com"
    );
  });
  it("falls back to X-Original-Sender when Reply-To is missing", () => {
    assert.equal(
      resolveOriginalSender({
        from: "bounces+SRS=vAN5T=H5@rvfb.org",
        originalSender: "AP <ap@carusos.com>"
      }),
      "ap@carusos.com"
    );
  });
  it("decodes plaintext SRS from the envelope sender", () => {
    assert.equal(
      resolveOriginalSender({ from: "SRS0=HHH=TT=charliesproduce.com=orders@fwd.net" }),
      "orders@charliesproduce.com"
    );
  });
  it("labels opaque SRS envelopes with forwarded-via@<domain>", () => {
    assert.equal(
      resolveOriginalSender({ from: "bounces+SRS=vAN5T=H5@rvfb.org" }),
      "forwarded-via@rvfb.org"
    );
  });
  it("passes through plain addresses untouched", () => {
    assert.equal(
      resolveOriginalSender({ from: "AP <ap@charlies-produce.com>" }),
      "ap@charlies-produce.com"
    );
  });
});
