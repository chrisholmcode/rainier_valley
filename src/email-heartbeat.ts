// Silent-breakage heartbeat for the inbound-email pipeline.
//
// The highest-risk failure mode of email intake is that the forwarding rule
// at billing@rvfb.org quietly stops working — Charlie's keeps sending, we
// never receive, and nobody notices until Lester realizes the sheet is thin.
// This module scans the Processed Emails tab once a day and DMs the admin
// when a vendor's most-recent inbound is past its expected cadence.
//
// Configured via EMAIL_HEARTBEAT_VENDORS. Unset = disabled.

import { env } from "./config.js";
import { readProcessedEmails, type ProcessedEmailLogEntry } from "./sheets.js";

export interface VendorRule {
  pattern: string;   // "@charlies-produce.com" | "*@charlies-produce.com" | "billing@rvfb.org"
  staleDays: number;
}

export function parseVendorConfig(csv: string): VendorRule[] {
  return csv
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const colonIdx = part.lastIndexOf(":");
      if (colonIdx < 0) throw new Error(`Bad EMAIL_HEARTBEAT_VENDORS entry (missing ":days"): ${part}`);
      const pattern = part.slice(0, colonIdx).trim().toLowerCase();
      const staleDays = Number(part.slice(colonIdx + 1).trim());
      if (!pattern) throw new Error(`Bad EMAIL_HEARTBEAT_VENDORS entry (empty pattern): ${part}`);
      if (!Number.isFinite(staleDays) || staleDays <= 0) {
        throw new Error(`Bad EMAIL_HEARTBEAT_VENDORS entry (non-positive days): ${part}`);
      }
      return { pattern, staleDays };
    });
}

// Same semantics as isSenderAllowed in email-intake.ts. Duplicated (not
// imported) so email-intake and email-heartbeat can evolve independently.
function extractAddress(from: string): string | null {
  const angle = from.match(/<([^>]+)>/);
  const candidate = (angle ? angle[1] : from).trim().toLowerCase();
  if (!candidate.includes("@") || /\s/.test(candidate)) return null;
  return candidate;
}

export function matchesPattern(from: string, pattern: string): boolean {
  const addr = extractAddress(from);
  if (!addr) return false;
  const domain = addr.split("@")[1];
  const p = pattern.toLowerCase();
  if (p.startsWith("*@")) return domain === p.slice(2);
  if (p.startsWith("@")) return domain === p.slice(1);
  return addr === p;
}

export interface VendorStatus {
  pattern: string;
  staleDays: number;
  lastReceivedAt: Date | null;
  daysSinceLastReceived: number | null;
  isStale: boolean;
}

// How long the pipe has actually been receiving email, measured from the
// oldest Processed Emails row. Used to gate `never_seen` alerts — a vendor
// that "hasn't emailed us in 10 days" is only newsworthy once the pipe has
// been up for at least 10 days. Returns null if the tab has no rows yet.
export function computePipeAgeDays(rows: ProcessedEmailLogEntry[], now: Date): number | null {
  let oldest: number | null = null;
  for (const row of rows) {
    const ts = Date.parse(row.receivedAt);
    if (Number.isNaN(ts)) continue;
    if (oldest === null || ts < oldest) oldest = ts;
  }
  if (oldest === null) return null;
  return (now.getTime() - oldest) / (24 * 60 * 60 * 1000);
}

// Pure function — takes the sheet snapshot and returns per-vendor status.
// Any row matches (regardless of `result`) because the question is "did the
// mail arrive," not "did extraction succeed." Dedup hits and extraction
// failures both prove the pipe is alive.
export function computeVendorStatuses(
  rules: VendorRule[],
  rows: ProcessedEmailLogEntry[],
  now: Date
): VendorStatus[] {
  return rules.map((rule) => {
    let lastReceivedAt: Date | null = null;
    for (const row of rows) {
      if (!matchesPattern(row.from, rule.pattern)) continue;
      const ts = Date.parse(row.receivedAt);
      if (Number.isNaN(ts)) continue;
      if (!lastReceivedAt || ts > lastReceivedAt.getTime()) {
        lastReceivedAt = new Date(ts);
      }
    }
    const daysSinceLastReceived = lastReceivedAt
      ? (now.getTime() - lastReceivedAt.getTime()) / (24 * 60 * 60 * 1000)
      : null;
    const isStale = daysSinceLastReceived === null
      ? false // "never seen" is handled by the caller — needs the empty-tab check
      : daysSinceLastReceived > rule.staleDays;
    return { pattern: rule.pattern, staleDays: rule.staleDays, lastReceivedAt, daysSinceLastReceived, isStale };
  });
}

// ── Runner ─────────────────────────────────────────────────────────────────

// Per-pattern alert cooldown so a persistently-stale vendor doesn't fire an
// alert every 24h forever. Lost on restart (acceptable — one extra alert
// after a redeploy is fine).
const alertedAt = new Map<string, number>();
const ALERT_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

function formatAlert(status: VendorStatus, reason: "stale" | "never_seen"): string {
  const header = "⚠️ *Loadslip email heartbeat*";
  if (reason === "never_seen") {
    return `${header}\nNo email ever received from \`${status.pattern}\` (threshold: ${status.staleDays}d).\nCheck: (1) forwarding rule at billing@rvfb.org, (2) Cloudflare Email Routing for invoices@loadslip.com, (3) Worker allowlist.`;
  }
  const days = status.daysSinceLastReceived!.toFixed(1);
  const lastStr = status.lastReceivedAt!.toISOString().slice(0, 10);
  return `${header}\nNo email from \`${status.pattern}\` in ${days} days (threshold: ${status.staleDays}d, last: ${lastStr}).\nCheck the forwarding rule at billing@rvfb.org.`;
}

export interface HeartbeatRunResult {
  ran: boolean;
  reason?: "disabled" | "tab_empty" | "checked";
  alerts: string[];
}

export async function runEmailHeartbeatCheck(params: {
  alertAdmin: (text: string) => Promise<void>;
  now?: Date;
}): Promise<HeartbeatRunResult> {
  if (!env.EMAIL_HEARTBEAT_VENDORS) return { ran: false, reason: "disabled", alerts: [] };

  let rules: VendorRule[];
  try {
    rules = parseVendorConfig(env.EMAIL_HEARTBEAT_VENDORS);
  } catch (err) {
    console.warn(`[email-heartbeat] bad config, disabling: ${(err as Error).message}`);
    return { ran: false, reason: "disabled", alerts: [] };
  }
  if (rules.length === 0) return { ran: false, reason: "disabled", alerts: [] };

  const now = params.now ?? new Date();
  const rows = await readProcessedEmails();

  // Pipe-age guard: only fire `never_seen` for a vendor once the pipe has
  // been receiving mail for longer than that vendor's staleDays threshold.
  // Prevents "no Charlies email in 10 days" from firing during the first
  // 10 days the pipe is even live. Also covers the empty-tab case (null age).
  const pipeAgeDays = computePipeAgeDays(rows, now);
  const tabEmpty = rows.length === 0;
  const statuses = computeVendorStatuses(rules, rows, now);

  const alerts: string[] = [];
  for (const status of statuses) {
    let reason: "stale" | "never_seen" | null = null;
    if (status.lastReceivedAt === null && pipeAgeDays !== null && pipeAgeDays > status.staleDays) {
      reason = "never_seen";
    } else if (status.isStale) {
      reason = "stale";
    }
    if (!reason) continue;

    const last = alertedAt.get(status.pattern) ?? 0;
    if (now.getTime() - last < ALERT_COOLDOWN_MS) {
      console.log(`[email-heartbeat] suppress ${status.pattern} (cooldown)`);
      continue;
    }

    const text = formatAlert(status, reason);
    alerts.push(text);
    try {
      await params.alertAdmin(text);
      alertedAt.set(status.pattern, now.getTime());
    } catch (err) {
      console.warn(`[email-heartbeat] alert send failed for ${status.pattern}: ${(err as Error).message}`);
    }
  }

  console.log(`[email-heartbeat] checked vendors=${rules.length} tabEmpty=${tabEmpty} pipeAgeDays=${pipeAgeDays === null ? "null" : pipeAgeDays.toFixed(1)} alerts=${alerts.length}`);
  return { ran: true, reason: tabEmpty ? "tab_empty" : "checked", alerts };
}

// Kick off a daily check. First run happens 60s after startup so container
// boot doesn't get its logs polluted with sheet-read latency.
const DAILY_MS = 24 * 60 * 60 * 1000;

export function startEmailHeartbeat(params: {
  alertAdmin: (text: string) => Promise<void>;
}): void {
  if (!env.EMAIL_HEARTBEAT_VENDORS) {
    console.log("[email-heartbeat] disabled (EMAIL_HEARTBEAT_VENDORS unset)");
    return;
  }
  const run = () => {
    runEmailHeartbeatCheck({ alertAdmin: params.alertAdmin }).catch((err) => {
      console.error(`[email-heartbeat] run failed: ${(err as Error).message}`);
    });
  };
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, DAILY_MS).unref();
  console.log("[email-heartbeat] scheduled daily");
}
