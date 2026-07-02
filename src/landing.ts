import { FONT_HEAD_LINKS } from "./ui-styles.js";

const LANDING_CSS = `
:root {
  --bg: #ffffff;
  --ink: #0a1626;
  --ink-2: #4a5568;
  --muted: #6b7580;
  --line: #e6e8eb;
  --accent: #635bff;
  --accent-hov: #524ad0;
  --pill-bg: #eef0f4;
  --card: #fafbfc;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg);
  color: var(--ink);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  font-feature-settings: 'ss01', 'cv11';
}
a { color: inherit; text-decoration: none; }
.container { max-width: 1120px; margin: 0 auto; padding: 0 32px; }

/* Nav */
.nav {
  display: flex; align-items: center; justify-content: space-between;
  padding: 24px 0; border-bottom: 1px solid var(--line);
}
.brand { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 20px; letter-spacing: -0.02em; }
.brand-dot { width: 12px; height: 12px; background: var(--accent); border-radius: 3px; }
.nav-actions { display: flex; align-items: center; gap: 20px; font-size: 14px; }
.nav-actions a.link { color: var(--ink-2); }
.nav-actions a.link:hover { color: var(--ink); }
.btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 10px 18px; border-radius: 999px; font-weight: 600; font-size: 14px;
  border: 1px solid transparent;
  transition: transform .08s ease, box-shadow .12s ease, background .12s ease;
}
.btn-primary { background: var(--ink); color: #fff; }
.btn-primary:hover { background: var(--accent); }
.btn-ghost { background: #fff; color: var(--ink); border-color: var(--line); }
.btn-ghost:hover { background: var(--card); }
.btn-lg { padding: 14px 24px; font-size: 15px; }

/* Hero */
.hero {
  padding: 96px 0 72px;
  display: grid; grid-template-columns: minmax(0, 640px);
}
.eyebrow {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase;
  color: var(--ink-2); background: var(--pill-bg);
  padding: 6px 12px; border-radius: 999px; width: fit-content; margin-bottom: 24px;
  font-weight: 600;
}
.eyebrow-dot { width: 6px; height: 6px; border-radius: 50%; background: #00805f; }
.headline {
  font-size: clamp(44px, 6vw, 76px); font-weight: 700; letter-spacing: -0.035em;
  line-height: 1.05; margin: 0 0 24px;
}
.sub {
  font-size: 20px; color: var(--ink-2); line-height: 1.55; margin: 0 0 32px; max-width: 620px;
}
.cta-row { display: flex; gap: 12px; flex-wrap: wrap; }
.cta-note { color: var(--muted); font-size: 13px; margin-top: 20px; }

/* Sections */
section { padding: 72px 0; border-top: 1px solid var(--line); }
.section-title {
  font-size: 14px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted);
  font-weight: 600; margin: 0 0 12px;
}
.section-lead {
  font-size: clamp(28px, 3.4vw, 40px); font-weight: 700; letter-spacing: -0.02em;
  line-height: 1.15; margin: 0 0 48px; max-width: 720px;
}
.features { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }
.feature {
  background: var(--card); border: 1px solid var(--line); border-radius: 16px;
  padding: 28px; display: flex; flex-direction: column; gap: 12px;
}
.feature-num {
  width: 32px; height: 32px; border-radius: 8px; background: var(--ink); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 14px; margin-bottom: 4px;
}
.feature h3 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: -0.01em; }
.feature p { margin: 0; color: var(--ink-2); font-size: 15px; line-height: 1.55; }

.flow { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
.flow-step {
  background: #fff; border: 1px solid var(--line); border-radius: 12px;
  padding: 20px; position: relative;
}
.flow-step .step-n { color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
.flow-step h4 { margin: 8px 0 6px; font-size: 15px; font-weight: 700; letter-spacing: -0.01em; }
.flow-step p { margin: 0; color: var(--ink-2); font-size: 13px; line-height: 1.5; }

.callout {
  background: var(--ink); color: #fff; border-radius: 20px; padding: 48px;
  display: grid; grid-template-columns: 1fr auto; gap: 24px; align-items: center;
}
.callout h3 { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 8px; line-height: 1.2; }
.callout p { color: rgba(255,255,255,0.75); margin: 0; font-size: 15px; }
.callout .btn-primary { background: #fff; color: var(--ink); }
.callout .btn-primary:hover { background: #eee; }

/* Footer */
footer { padding: 40px 0 60px; color: var(--muted); font-size: 13px; }
.footer-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }

@media (max-width: 800px) {
  .features { grid-template-columns: 1fr; }
  .flow { grid-template-columns: 1fr 1fr; }
  .callout { grid-template-columns: 1fr; text-align: left; }
  .hero { padding: 56px 0 40px; }
  section { padding: 48px 0; }
}
`;

export function buildLandingHtml(params: { reviewUrl: string }): string {
  const { reviewUrl } = params;
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><title>Loadslip — Delivery slips, structured.</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Photograph an invoice in Slack. Loadslip extracts every line item, reconciles weights against supplier catalogs, and files it — with a human review UI for the calls it isn't sure about.">
${FONT_HEAD_LINKS}
<style>${LANDING_CSS}</style>
</head><body>

<div class="container">
  <nav class="nav">
    <div class="brand">
      <span class="brand-dot"></span>
      Loadslip
    </div>
    <div class="nav-actions">
      <a class="link" href="#how">How it works</a>
      <a class="link" href="#features">Features</a>
      <a class="btn btn-ghost" href="${reviewUrl}">Sign in</a>
    </div>
  </nav>

  <header class="hero">
    <div>
      <div class="eyebrow"><span class="eyebrow-dot"></span> Live at Rainier Valley Food Bank</div>
      <h1 class="headline">Delivery slips, structured.</h1>
      <p class="sub">
        Photograph an invoice in Slack. Loadslip classifies, extracts every line
        item, reconciles weights against the supplier's catalog, and files it in
        your spreadsheet — with a review queue for the calls it isn't sure about.
      </p>
      <div class="cta-row">
        <a class="btn btn-primary btn-lg" href="${reviewUrl}">Open the review app →</a>
        <a class="btn btn-ghost btn-lg" href="#how">See how it works</a>
      </div>
      <div class="cta-note">Access is gated — reviewers sign in with a one-time code sent to their email.</div>
    </div>
  </header>
</div>

<section id="how">
  <div class="container">
    <div class="section-title">How it works</div>
    <h2 class="section-lead">From a phone photo to a clean row — usually inside a minute.</h2>
    <div class="flow">
      <div class="flow-step">
        <div class="step-n">01</div>
        <h4>Snap in Slack</h4>
        <p>Reviewer uploads a photo or PDF of a delivery slip to a channel the bot watches.</p>
      </div>
      <div class="flow-step">
        <div class="step-n">02</div>
        <h4>Classify + extract</h4>
        <p>Claude classifies invoice vs. whiteboard and returns every line item with confidence scores.</p>
      </div>
      <div class="flow-step">
        <div class="step-n">03</div>
        <h4>Reconcile</h4>
        <p>Supplier SKUs are cross-checked against the vendor catalog. Authoritative weights overwrite OCR guesses.</p>
      </div>
      <div class="flow-step">
        <div class="step-n">04</div>
        <h4>File + queue</h4>
        <p>High-confidence rows land in the inventory sheet. Low-confidence ones queue for human review.</p>
      </div>
    </div>
  </div>
</section>

<section id="features">
  <div class="container">
    <div class="section-title">What's inside</div>
    <h2 class="section-lead">Built for food banks — small teams, real invoices, no time to babysit software.</h2>
    <div class="features">
      <div class="feature">
        <div class="feature-num">1</div>
        <h3>Slack-native intake</h3>
        <p>No app to install. Photograph the slip on your phone, drop it in Slack, walk away. Whiteboard tallies and voice memos work too.</p>
      </div>
      <div class="feature">
        <div class="feature-num">2</div>
        <h3>Weights that match reality</h3>
        <p>Catalog cross-check catches OCR errors and fills in pack weights for count-only line items (56 CT navel oranges → 38 lb, verified).</p>
      </div>
      <div class="feature">
        <div class="feature-num">3</div>
        <h3>Review, don't rewrite</h3>
        <p>Every low-confidence extraction lands in a queue with a per-field editor. Every change is logged for future prompt tuning.</p>
      </div>
      <div class="feature">
        <div class="feature-num">4</div>
        <h3>Durable audit trail</h3>
        <p>Every extraction — including Claude's thinking trace — is persisted to a Google Sheet tab. Nothing depends on log retention.</p>
      </div>
      <div class="feature">
        <div class="feature-num">5</div>
        <h3>Prompt suggestions from reviewers</h3>
        <p>Reviewers flag patterns the extractor misses. Suggestions ping the admin for review — prompt files still land through git.</p>
      </div>
      <div class="feature">
        <div class="feature-num">6</div>
        <h3>Secure by default</h3>
        <p>Access-gated via Cloudflare, email one-time PIN sign-in. No shared tokens. Data stays in your Google account.</p>
      </div>
    </div>
  </div>
</section>

<section>
  <div class="container">
    <div class="callout">
      <div>
        <h3>Ready to look inside?</h3>
        <p>The review queue is a good picture of what Loadslip does day-to-day. Sign in and take a look.</p>
      </div>
      <a class="btn btn-primary btn-lg" href="${reviewUrl}">Open the review app →</a>
    </div>
  </div>
</section>

<footer>
  <div class="container footer-row">
    <div>© ${new Date().getFullYear()} Loadslip — built with the team at Rainier Valley Food Bank.</div>
    <div><a class="link" href="${reviewUrl}">Reviewers sign in →</a></div>
  </div>
</footer>

</body></html>`;
}
