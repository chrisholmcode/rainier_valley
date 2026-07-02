// Walk all Caruso catalog pages and extract {sku, name, packSize} per tile.
// Scrolls to force lazy-load hydration on each page.
// Output: out/caruso-listing.json
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = "https://carusoproduce.cutanddry.com/catalog/CarusoProduceInc";
const SUFFIX = "?verifiedVendorId=271724692&categoryId=1";
const LAST_PAGE = 57;
const OUT_DIR = new URL("./out/", import.meta.url).pathname;

async function scrollToBottom(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let y = 0;
      const step = 500;
      const tick = setInterval(() => {
        window.scrollBy(0, step);
        y += step;
        if (y >= document.body.scrollHeight) { clearInterval(tick); resolve(); }
      }, 200);
    });
  });
  await page.waitForTimeout(1500);
}

async function scrapePage(page, pageNum) {
  const url = `${BASE}${SUFFIX}&page=${pageNum}`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
  await page.waitForTimeout(2000);
  await scrollToBottom(page);
  return page.evaluate(() => {
    const results = [];
    const packNodes = document.querySelectorAll("[class*='_1evg3oy']");
    for (const packNode of packNodes) {
      const packText = packNode.textContent?.trim() ?? "";
      if (!packText.includes("#")) continue;
      let card = packNode.parentElement;
      let name = null;
      for (let i = 0; i < 5 && card; i++) {
        const n = card.querySelector("[class*='_3quvq7']");
        if (n) { name = n.textContent?.trim() ?? null; break; }
        card = card.parentElement;
      }
      results.push({ name, packRaw: packText });
    }
    return results;
  });
}

function parsePack(raw) {
  const m = raw.match(/^(.*?)\s*\|\s*#\s*(\S+)\s*$/);
  return m ? { packSize: m[1].trim(), sku: m[2].trim() } : { packSize: raw, sku: null };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();

  const bySku = new Map();
  let orphans = 0;

  for (let p = 1; p <= LAST_PAGE; p++) {
    let tries = 0;
    while (tries < 3) {
      try {
        const tiles = await scrapePage(page, p);
        for (const t of tiles) {
          const parsed = parsePack(t.packRaw);
          if (!parsed.sku) { orphans++; continue; }
          if (!bySku.has(parsed.sku)) {
            bySku.set(parsed.sku, { sku: parsed.sku, name: t.name, packSize: parsed.packSize });
          }
        }
        console.log(`page ${p}/${LAST_PAGE}: tiles=${tiles.length} total_skus=${bySku.size}`);
        break;
      } catch (err) {
        tries++;
        console.warn(`page ${p} attempt ${tries} failed: ${err.message}`);
        await page.waitForTimeout(2000 * tries);
        if (tries === 3) console.error(`giving up on page ${p}`);
      }
    }
  }

  const items = Array.from(bySku.values()).sort((a, b) => a.sku.localeCompare(b.sku));
  const outPath = path.join(OUT_DIR, "caruso-listing.json");
  await writeFile(
    outPath,
    JSON.stringify(
      { scrapedAt: new Date().toISOString(), totalWithSku: items.length, orphanCount: orphans, items },
      null,
      2
    ),
    "utf8"
  );
  console.log(`\nWrote ${items.length} items to ${outPath} (orphans: ${orphans})`);

  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
