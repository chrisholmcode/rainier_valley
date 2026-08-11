// Cloudflare Email Worker — forwards vendor invoice attachments (Charlie's,
// Caruso's, etc.) to the Loadslip inbound-email webhook. Deliberately dumb:
// parse MIME, filter senders + attachments, HMAC-sign, POST with retry, and
// dead-letter forward anything we can't hand off. All extraction, dedup, and
// audit logic lives on the Loadslip side (src/email-intake.ts).
//
// Bindings (see wrangler.toml + `wrangler secret put`):
//   LOADSLIP_WEBHOOK_URL     — https://review.loadslip.com/api/inbound-email
//   LOADSLIP_WEBHOOK_SECRET  — shared HMAC secret (matches EMAIL_INTAKE_SECRET)
//   ALLOWED_SENDERS          — CSV: exact addr, `@domain`, or `*@domain`
//   DEAD_LETTER_EMAIL        — where undeliverable/rejected mail is forwarded

import PostalMime from "postal-mime";

interface Env {
  LOADSLIP_WEBHOOK_URL: string;
  LOADSLIP_WEBHOOK_SECRET: string;
  ALLOWED_SENDERS: string;
  DEAD_LETTER_EMAIL: string;
}

const ACCEPTED_MIME = /^(image\/(jpeg|png|webp|heic|heif|gif)|application\/pdf)$/i;

// ── Auth helpers ───────────────────────────────────────────────────────────

// Parse Cloudflare's `Authentication-Results` header. Requires SPF or DKIM to
// pass — some legitimate senders sign only one. Both failing means the mail
// is untrusted and we reject at SMTP.
function authPasses(headers: Headers): boolean {
  const raw = headers.get("Authentication-Results") ?? "";
  const spfPass = /spf=pass\b/i.test(raw);
  const dkimPass = /dkim=pass\b/i.test(raw);
  return spfPass || dkimPass;
}

function normalizeAddress(from: string): string | null {
  const angle = from.match(/<([^>]+)>/);
  const candidate = (angle ? angle[1] : from).trim().toLowerCase();
  if (!candidate.includes("@") || /\s/.test(candidate)) return null;
  return candidate;
}

function isSenderAllowed(from: string, allowlistCsv: string): boolean {
  const addr = normalizeAddress(from);
  if (!addr) return false;
  const domain = addr.split("@")[1];
  const patterns = allowlistCsv.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
  return patterns.some((p) => {
    if (p.startsWith("*@")) return domain === p.slice(2);
    if (p.startsWith("@")) return domain === p.slice(1);
    return addr === p;
  });
}

// ── Crypto (Web Crypto, no Node polyfill needed) ──────────────────────────

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // btoa handles binary strings up to a few MB fine; PDFs comfortably fit.
  let bin = "";
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
  return btoa(bin);
}

// ── Webhook POST with retry ────────────────────────────────────────────────

// 3 attempts with exponential backoff: ~0s, 2s, 6s. Fast-fails on 4xx that
// won't succeed on retry (401/403/400) — those are config bugs, not transient.
//
// Per-attempt timeout: 150s. The real ceiling is Cloudflare's edge proxy
// timeout at review.loadslip.com — 100s on Free/Pro/Business plans (only
// Enterprise can bump). Setting the AbortController above that ensures CF's
// 524 arrives cleanly before we tear down the socket, so logs distinguish
// "edge timed out waiting for Railway" from "network partition dropped us."
const REQUEST_TIMEOUT_MS = 150_000;

async function postWithRetry(url: string, body: string, signature: string): Promise<Response> {
  const backoffsMs = [0, 2000, 6000];
  let lastResp: Response | null = null;
  let lastErr: Error | null = null;

  for (let i = 0; i < backoffsMs.length; i++) {
    if (backoffsMs[i] > 0) await new Promise((r) => setTimeout(r, backoffsMs[i]));

    // Fresh controller per attempt — reusing one would abort future retries.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Loadslip-Signature": `sha256=${signature}`
        },
        body,
        signal: controller.signal
      });
      if (resp.ok) return resp;
      lastResp = resp;
      // 524 (CF edge timeout waiting on origin) and 502/503/504 are transient
      // and worth retrying; 408/429 same. Everything else 4xx is config.
      const status = resp.status;
      const isRetryable = status === 408 || status === 429 || (status >= 500 && status <= 599);
      if (!isRetryable) return resp;
      console.log(`webhook attempt ${i + 1}/${backoffsMs.length} non-2xx status=${status} dur=${Date.now() - startedAt}ms — retrying`);
    } catch (err) {
      const e = err as Error;
      lastErr = e;
      const dur = Date.now() - startedAt;
      // Distinguish AbortError (our 150s cap fired) from real network errors
      // so log-diving is straightforward when this eventually bites.
      const cause = e.name === "AbortError" ? `client-timeout(${REQUEST_TIMEOUT_MS}ms)` : `${e.name}: ${e.message}`;
      console.log(`webhook attempt ${i + 1}/${backoffsMs.length} threw dur=${dur}ms cause=${cause}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }
  if (lastResp) return lastResp;
  throw lastErr ?? new Error("Retry loop exhausted");
}

// ── Main handler ───────────────────────────────────────────────────────────

async function deadLetter(message: ForwardableEmailMessage, env: Env, reason: string): Promise<void> {
  console.log(`dead-letter reason="${reason}" from=${message.from} to=${message.to}`);
  try {
    await message.forward(env.DEAD_LETTER_EMAIL);
  } catch (err) {
    console.error(`dead-letter forward failed: ${(err as Error).message}`);
  }
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    const messageId = message.headers.get("Message-ID") ?? message.headers.get("Message-Id") ?? `synth-${Date.now()}-${crypto.randomUUID()}`;
    const subject = message.headers.get("Subject") ?? "";
    const from = message.from;

    // 1. SPF/DKIM — hard reject if both fail. Sender allowlist next.
    if (!authPasses(message.headers)) {
      message.setReject("Authentication (SPF/DKIM) failed");
      console.log(`reject auth-failed from=${from} message_id=${messageId}`);
      return;
    }
    if (!isSenderAllowed(from, env.ALLOWED_SENDERS)) {
      message.setReject("Sender not allowed");
      console.log(`reject sender-not-allowed from=${from} message_id=${messageId}`);
      return;
    }

    // 2. Parse MIME. postal-mime handles all the encoding edge cases.
    let parsed;
    try {
      parsed = await PostalMime.parse(message.raw);
    } catch (err) {
      console.error(`mime parse failed from=${from} message_id=${messageId}: ${(err as Error).message}`);
      await deadLetter(message, env, `MIME parse failed: ${(err as Error).message}`);
      return;
    }

    // 3. Filter to acceptable attachments. If none, dead-letter so a vendor
    //    format change surfaces instead of silently dropping.
    const attachments = (parsed.attachments ?? [])
      .filter((a) => a.mimeType && ACCEPTED_MIME.test(a.mimeType) && a.content)
      .map((a) => ({
        filename: a.filename ?? "attachment",
        mimeType: a.mimeType!,
        contentBase64: toBase64(a.content as ArrayBuffer)
      }));

    if (attachments.length === 0) {
      await deadLetter(message, env, "No PDF/image attachments after filter");
      return;
    }

    // 4. Build envelope, sign, POST.
    const envelope = {
      messageId,
      from,
      subject,
      receivedAt: new Date().toISOString(),
      attachments
    };
    const body = JSON.stringify(envelope);
    const signature = await hmacSha256Hex(env.LOADSLIP_WEBHOOK_SECRET, body);

    let resp: Response;
    try {
      resp = await postWithRetry(env.LOADSLIP_WEBHOOK_URL, body, signature);
    } catch (err) {
      console.error(`webhook post threw from=${from} message_id=${messageId}: ${(err as Error).message}`);
      await deadLetter(message, env, `Webhook error: ${(err as Error).message}`);
      return;
    }

    if (!resp.ok) {
      const responseText = await resp.text().catch(() => "<unreadable>");
      console.error(`webhook non-2xx from=${from} message_id=${messageId} status=${resp.status} body=${responseText.slice(0, 500)}`);
      await deadLetter(message, env, `Webhook returned ${resp.status}`);
      return;
    }

    console.log(`ok from=${from} message_id=${messageId} attachments=${attachments.length}`);
  }
};
