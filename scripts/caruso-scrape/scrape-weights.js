// Scrape Net Weight for a specific list of Caruso SKUs (CT-only, RVFB-seen).
// For each SKU:
//   1. navigate to search URL
//   2. find the card whose pack/sku line ends in "#{SKU}"
//   3. click it → detail page URL contains /product/{productId}
//   4. parse "Net Weight X.XXXX Lb" from the detail page
// Output: out/caruso-weights.json  (merged with catalog by a follow-up step)

import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const RVFB_SKUS_PATH = path.join("out", "rvfb-caruso-skus.json");
const OUT_PATH = path.join("out", "caruso-weights.json");
const BASE = "https://carusoproduce.cutanddry.com/catalog/CarusoProduceInc?verifiedVendorId=271724692&categoryId=1";

async function scrapeOne(page, sku) {
  const searchUrl = `${BASE}&search=${sku}`;
  await page.goto(searchUrl, { waitUntil: "networkidle", timeout: 45_000 });
  await page.waitForTimeout(1500);

  // Find the card whose pack/sku line ends in `#{sku}`.
  const clicked = await page.evaluate((sku) => {
    const packNodes = Array.from(document.querySelectorAll("[class*='_1evg3oy']"));
    for (const pn of packNodes) {
      const txt = (pn.textContent || "").trim();
      if (txt.endsWith(`#${sku}`)) {
        // Walk up to a clickable card container and click it.
        let el = pn.parentElement;
        for (let i = 0; i < 6 && el; i++) {
          if (el.querySelector("[class*='_3quvq7']")) {
            el.querySelector("[class*='_3quvq7']").click();
            return true;
          }
          el = el.parentElement;
        }
      }
    }
    return false;
  }, sku);

  if (!clicked) return { sku, ok: false, reason: "no-card-found" };

  // Wait for navigation to the detail page.
  try {
    await page.waitForURL(/\/product\/\d+/, { timeout: 12_000 });
  } catch {
    return { sku, ok: false, reason: "no-navigation" };
  }
  await page.waitForTimeout(1200);

  const url = page.url();
  const pidMatch = url.match(/\/product\/(\d+)/);
  const productId = pidMatch ? pidMatch[1] : null;

  // Extract name, sku confirmation, weight from body text.
  const body = await page.locator("body").innerText();
  const nameGuess = body.split("\n").find((line) => /^[A-Z][A-Z0-9 \/#'-]{4,}$/.test(line.trim()));
  const skuMatch = body.match(/SKU#?\s*(\S+)/i);
  const weightMatch = body.match(/Net\s*Weight[\s\S]{0,80}?([\d.]+)\s*(lb|oz|kg)/i);

  return {
    sku,
    ok: true,
    productId,
    confirmedSku: skuMatch?.[1] ?? null,
    name: nameGuess?.trim() ?? null,
    weightRaw: weightMatch ? `${weightMatch[1]} ${weightMatch[2]}` : null,
    weightLb: weightMatch ? toLb(parseFloat(weightMatch[1]), weightMatch[2]) : null
  };
}

function toLb(value, unit) {
  if (Number.isNaN(value)) return null;
  const u = unit.toLowerCase();
  if (u === "lb") return Math.round(value * 1000) / 1000;
  if (u === "oz") return Math.round((value / 16) * 1000) / 1000;
  if (u === "kg") return Math.round(value * 2.20462 * 1000) / 1000;
  return null;
}

async function main() {
  const rvfb = JSON.parse(await readFile(RVFB_SKUS_PATH, "utf8"));
  const targets = rvfb.ctOnlySkus ?? [];
  console.log(`Targets: ${targets.length} CT-only RVFB SKUs`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();

  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const sku = targets[i];
    let tries = 0;
    let res = null;
    while (tries < 3) {
      try { res = await scrapeOne(page, sku); break; }
      catch (err) { tries++; console.warn(`SKU ${sku} attempt ${tries} err: ${err.message}`); await page.waitForTimeout(2000 * tries); }
    }
    if (!res) res = { sku, ok: false, reason: "max-retries" };
    results.push(res);
    console.log(`  [${i + 1}/${targets.length}] ${sku} -> ${res.ok ? `${res.weightLb ?? "?"} lb (name=${res.name ?? "?"})` : `FAIL: ${res.reason}`}`);
  }

  await writeFile(
    OUT_PATH,
    JSON.stringify({ scrapedAt: new Date().toISOString(), count: results.length, results }, null, 2),
    "utf8"
  );
  console.log(`\nwrote ${OUT_PATH}`);
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
