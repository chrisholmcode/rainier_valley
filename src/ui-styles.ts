// Shared design tokens + base styles for the dashboard and review surfaces.
// Inspired by Stripe + Ramp: monochrome neutral surface, single violet accent,
// Inter typography, sharp lines, generous whitespace, tabular numerics.

// Inject this in <head> BEFORE the <style> tag so Inter loads non-blocking
// and the page renders with the real font on first paint. @import inside
// <style> is render-blocking and unreliable on first load.
export const FONT_HEAD_LINKS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
`;

export const SHARED_CSS = `
:root {
  --bg:           #f6f5f4;
  --card:         #ffffff;
  --ink:          #0a2540;
  --ink-2:        #425466;
  --muted:        #697386;
  --line:         #e3e8ee;
  --line-strong:  #cfd7e0;
  --hover:        #f4f5f8;

  --primary:      #635bff;
  --primary-bg:   #f1f0ff;
  --primary-hov:  #524ad0;

  --ok:           #00805f;
  --ok-bg:        #e6f6ef;
  --warn:         #9a6308;
  --warn-bg:      #fef3c7;
  --danger:       #cd3500;
  --danger-bg:    #fef2f2;

  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-pill: 999px;
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-feature-settings: 'cv02','cv03','cv04','cv11';
  background: var(--bg);
  color: var(--ink);
  font-size: 14px;
  line-height: 1.5;
  letter-spacing: -0.005em;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

.container { max-width: 1400px; margin: 0 auto; padding: 32px 32px 64px; }

/* Header */
header.page {
  display: flex; justify-content: space-between; align-items: flex-end;
  gap: 24px; flex-wrap: wrap;
  padding-bottom: 20px; margin-bottom: 28px;
  border-bottom: 1px solid var(--line);
}
header.page h1 {
  margin: 0;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 32px; font-weight: 700; letter-spacing: -0.03em;
  color: var(--ink);
  line-height: 1.15;
}
header.page .meta { color: var(--muted); font-size: 13px; margin-top: 6px; }

/* Toolbar / button groups */
.toolbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.btn-group { display: inline-flex; gap: 6px; }

.btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 14px;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--ink);
  border-radius: var(--radius-pill);
  font-family: inherit; font-size: 13px; font-weight: 600;
  text-decoration: none; cursor: pointer; line-height: 1;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.btn:hover:not(.active) { background: var(--hover); border-color: var(--line-strong); }
.btn.active { background: var(--ink); color: #fff; border-color: var(--ink); }

.btn-primary {
  background: var(--primary); color: #fff; border-color: var(--primary);
  border-radius: var(--radius-md);
  padding: 8px 16px;
}
.btn-primary:hover { background: var(--primary-hov); border-color: var(--primary-hov); color: #fff; }

.btn-secondary { border-radius: var(--radius-md); padding: 8px 14px; }

.btn-export { color: var(--ok); border-color: var(--line); border-radius: var(--radius-md); padding: 8px 14px; }
.btn-export:hover { background: var(--ok-bg); border-color: var(--ok); color: var(--ok); }

.btn-danger { color: var(--danger); border-color: var(--line); }
.btn-danger:hover { background: var(--danger-bg); border-color: var(--danger); }

/* Headings */
h2 {
  margin: 32px 0 14px;
  font-size: 13px; font-weight: 600;
  color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em;
}
h2:first-of-type { margin-top: 0; }
h3 { margin: 0 0 14px; font-size: 15px; font-weight: 700; letter-spacing: -0.01em; color: var(--ink); }

/* Cards */
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  padding: 20px;
  margin-bottom: 16px;
  box-shadow: 0 1px 0 rgba(50,50,93,0.025);
}

/* Summary pills */
.summary-row { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
.summary-pill {
  background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-lg);
  padding: 16px 20px; min-width: 200px;
  box-shadow: 0 1px 0 rgba(50,50,93,0.025);
}
.summary-pill .label {
  color: var(--muted); font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.06em;
}
.summary-pill .value {
  font-size: 26px; font-weight: 700; letter-spacing: -0.025em;
  margin-top: 6px; font-variant-numeric: tabular-nums;
  color: var(--ink);
}
.summary-pill.in   { border-left: 3px solid var(--ok); }
.summary-pill.out  { border-left: 3px solid var(--warn); }
.summary-pill.in .value { color: var(--ok); }
.summary-pill.out .value { color: var(--warn); }

/* Tables */
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td {
  padding: 12px 14px; border-bottom: 1px solid var(--line);
  font-variant-numeric: tabular-nums; vertical-align: top;
}
thead th {
  text-align: left;
  background: transparent;
  border-bottom: 1px solid var(--line);
  font-weight: 600; font-size: 11px; color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.06em;
  padding: 10px 14px;
}
tbody tr { transition: background 0.1s; }
tbody tr:hover td { background: var(--hover); }
tbody tr:last-child td { border-bottom: none; }
tbody th { text-align: left; font-weight: 600; color: var(--ink); background: transparent; white-space: nowrap; }
.num { text-align: right; }
.num-in   { color: var(--ok);   font-weight: 600; }
.num-out  { color: var(--warn); font-weight: 600; }
.muted    { color: var(--muted); font-weight: 400; }

/* Status badges */
.badge {
  display: inline-flex; align-items: center;
  padding: 3px 8px; border-radius: var(--radius-sm);
  font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.05em;
}
.badge-pending  { background: var(--warn-bg);  color: var(--warn); }
.badge-approved { background: var(--ok-bg);    color: var(--ok); }
.badge-human    { background: var(--primary-bg); color: var(--primary); }

/* Confidence pill */
.conf {
  display: inline-flex; padding: 2px 8px; border-radius: var(--radius-sm);
  font-weight: 600; font-size: 12px; font-variant-numeric: tabular-nums;
}
.conf-low { background: var(--danger-bg); color: var(--danger); }
.conf-ok  { background: var(--ok-bg);     color: var(--ok); }

/* Footer */
footer {
  margin-top: 40px; padding-top: 20px;
  border-top: 1px solid var(--line);
  color: var(--muted); font-size: 12px;
  text-align: center;
}
`;
