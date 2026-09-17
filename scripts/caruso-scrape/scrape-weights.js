// Scrape Net Weight for a specific list of Caruso SKUs (CT-only, RVFB-seen).
// For each SKU:
//   1. navigate to search URL
//   2. find the card whose pack/sku line ends in "#{SKU}"
//   3. click it → detail page URL contains /product/{productId}
//   4. parse "Net Weight X.XXXX Lb" from the detail page
// Output: out/caruso-weights.json  (merged with catalog by a follow-up step)
//
// Input file selection (in order):
//   --input=<path>         explicit path (relative to cwd), reads either an
//                          array or an object with { ctOnlySkus | targetSkus }
//   default:               out/rvfb-caruso-skus.json (ctOnlySkus)
// Output override:
//   --output=<path>        write results here instead of out/caruso-weights.json

import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function parseArgs() {
  const args = process.argv.slice(2);
  let input = path.join("out", "rvfb-caruso-skus.json");
  let output = path.join("out", "caruso-weights.json");
  for (const a of args) {
    if (a.startsWith("--input=")) input = a.slice("--input=".length);
    else if (a.startsWith("--output=")) output = a.slice("--output=".length);
  }
  return { input, output };
}

function extractTargetSkus(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.targetSkus)) return parsed.targetSkus;
  if (Array.isArray(parsed.ctOnlySkus)) return parsed.ctOnlySkus;
  throw new Error("input file must be an array or contain targetSkus/ctOnlySkus");
}

const { input: INPUT_PATH, output: OUT_PATH } = parseArgs();
const BASE = "https://carusoproduce.cutanddry.com/catalog/CarusoProduceInc?verifiedVendorId=271724692&categoryId=1";

async function scrapeOne(page, sku) {
  const searchUrl = `${BASE}&search=${sku}`;
  await page.goto(searchUrl, { waitUntil: "networkidle", timeout: 45_000 });
  await page.waitForTimeout(1500);

  // Find the card whose pack/sku line ends in `#{sku}`. Capture the pack
  // string (everything before " | #{sku}") before clicking so we can populate
  // packSize when merging brand-new SKUs into the catalog.
  const cardInfo = await page.evaluate((sku) => {
    const packNodes = Array.from(document.querySelectorAll("[class*='_1evg3oy']"));
    for (const pn of packNodes) {
      const txt = (pn.textContent || "").trim();
      if (txt.endsWith(`#${sku}`)) {
        const packMatch = txt.match(/^(.*?)\s*\|\s*#\s*\S+\s*$/);
        const packSize = packMatch ? packMatch[1].trim() : null;
        let el = pn.parentElement;
        for (let i = 0; i < 6 && el; i++) {
          if (el.querySelector("[class*='_3quvq7']")) {
            el.querySelector("[class*='_3quvq7']").click();
            return { clicked: true, packSize };
          }
          el = el.parentElement;
        }
      }
    }
    return { clicked: false, packSize: null };
  }, sku);

  if (!cardInfo.clicked) return { sku, ok: false, reason: "no-card-found" };

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
    packSize: cardInfo.packSize,
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
  const parsed = JSON.parse(await readFile(INPUT_PATH, "utf8"));
  const targets = extractTargetSkus(parsed);
  console.log(`input: ${INPUT_PATH}`);
  console.log(`output: ${OUT_PATH}`);
  console.log(`Targets: ${targets.length} SKU(s)`);

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
