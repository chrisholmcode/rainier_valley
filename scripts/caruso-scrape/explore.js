// Exploration pass: figure out how the Caruso catalog is structured on Cut & Dry.
// Outputs:
//   out/catalog-root.html         — rendered HTML of the catalog landing page
//   out/catalog-root.png          — screenshot
//   out/product-338478343.html    — rendered HTML of the known jumbo-carrot page
//   out/product-338478343.png     — screenshot
//   out/product-links.json        — all catalog-product hrefs discovered on the root
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT_DIR = new URL("./out/", import.meta.url).pathname;
const CATALOG_ROOT = "https://carusoproduce.cutanddry.com/catalog/CarusoProduceInc";
const KNOWN_PRODUCT = "https://carusoproduce.cutanddry.com/catalog/CarusoProduceInc/product/338478343";

async function saveArtifacts(page, prefix) {
  const html = await page.content();
  await writeFile(path.join(OUT_DIR, `${prefix}.html`), html, "utf8");
  await page.screenshot({ path: path.join(OUT_DIR, `${prefix}.png`), fullPage: true });
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

  console.log("Visiting catalog root:", CATALOG_ROOT);
  await page.goto(CATALOG_ROOT, { waitUntil: "networkidle", timeout: 45_000 });
  await page.waitForTimeout(2500);
  await saveArtifacts(page, "catalog-root");

  const productLinks = await page.$$eval("a[href*='/product/']", (anchors) =>
    Array.from(new Set(anchors.map((a) => a.getAttribute("href")).filter(Boolean)))
  );
  console.log(`Found ${productLinks.length} product links on catalog root.`);
  await writeFile(
    path.join(OUT_DIR, "product-links.json"),
    JSON.stringify(productLinks, null, 2),
    "utf8"
  );

  console.log("Visiting known product:", KNOWN_PRODUCT);
  await page.goto(KNOWN_PRODUCT, { waitUntil: "networkidle", timeout: 45_000 });
  await page.waitForTimeout(2500);
  await saveArtifacts(page, "product-338478343");

  const skuText = await page.locator("body").innerText();
  const skuMatch = skuText.match(/SKU#?\s*(\S+)/i);
  const weightMatch = skuText.match(/Net\s*Weight[\s\S]{0,80}?([\d.]+\s*(?:lb|oz|kg))/i);
  console.log("SKU match:", skuMatch?.[1] ?? "(none)");
  console.log("Net Weight match:", weightMatch?.[1] ?? "(none)");

  await browser.close();
  console.log("Wrote artifacts to", OUT_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
