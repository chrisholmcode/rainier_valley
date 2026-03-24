#!/usr/bin/env npx tsx
/**
 * CLI tool to test extraction on sample images
 * Usage: npx tsx src/test-extraction.ts [image_path] [supplier_hint]
 *
 * Examples:
 *   npx tsx src/test-extraction.ts tests/fixtures/IMG_2718.jpg carusos
 *   npx tsx src/test-extraction.ts tests/fixtures/IMG_2721.jpg charlies
 *   npx tsx src/test-extraction.ts tests/fixtures/IMG_2719.jpg nw_harvest
 */

import { readFileSync } from "fs";
import { basename } from "path";
import { extractFromImage, guessSupplierFromFilename } from "./extraction.js";
import type { Supplier } from "./types.js";

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage: npx tsx src/test-extraction.ts <image_path> [supplier_hint]");
    console.log("\nSupplier hints: carusos, charlies, nw_harvest, pacific, unknown");
    console.log("\nExamples:");
    console.log("  npx tsx src/test-extraction.ts tests/fixtures/IMG_2718.jpg carusos");
    console.log("  npx tsx src/test-extraction.ts tests/fixtures/IMG_2721.jpg charlies");
    process.exit(1);
  }

  const imagePath = args[0];
  const supplierHint = (args[1] as Supplier) || guessSupplierFromFilename(basename(imagePath));

  console.log(`\n📄 Processing: ${imagePath}`);
  console.log(`🏷️  Supplier hint: ${supplierHint}`);
  console.log("⏳ Extracting...\n");

  const imageBytes = readFileSync(imagePath);
  const mimeType = imagePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

  const startTime = Date.now();

  try {
    const result = await extractFromImage({
      imageBytes,
      mimeType,
      filename: basename(imagePath),
      supplierHint
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`✅ Extraction complete in ${elapsed}s\n`);
    console.log("━".repeat(60));
    console.log(`Document Type: ${result.document_type}`);
    console.log(`Supplier: ${result.supplier}`);
    console.log(`Date: ${result.delivery_date || "N/A"}`);
    console.log(`Invoice/Order #: ${result.invoice_or_order_number || "N/A"}`);
    console.log(`Destination: ${result.destination_org || "N/A"}`);
    console.log("━".repeat(60));

    if (result.line_items.length > 0) {
      console.log(`\n📦 Line Items (${result.line_items.length}):\n`);
      for (const item of result.line_items) {
        const conf = item.confidence >= 0.85 ? "✅" : item.confidence >= 0.7 ? "⚠️" : "❓";
        const qty = item.quantity ?? item.quantity_raw ?? "?";
        const unit = item.unit || item.pack_size_raw || "";
        const cost = item.line_total ? `$${item.line_total.toFixed(2)}` : "";
        console.log(`  ${conf} ${item.item_name_normalized || item.item_name_raw} × ${qty} ${unit} ${cost} (${(item.confidence * 100).toFixed(0)}%)`);
      }
    } else {
      console.log("\n📦 No line items extracted");
    }

    if (result.fees.length > 0) {
      console.log(`\n💰 Fees (${result.fees.length}):`);
      for (const fee of result.fees) {
        console.log(`  • ${fee.description}: $${fee.amount.toFixed(2)}`);
      }
    }

    if (result.totals.grand_total) {
      console.log(`\n💵 Total: $${result.totals.grand_total.toFixed(2)}`);
    }

    if (result.source_warnings.length > 0) {
      console.log(`\n⚠️  Warnings:`);
      for (const warn of result.source_warnings) {
        console.log(`  • ${warn}`);
      }
    }

    // Output raw JSON for debugging
    console.log("\n━".repeat(60));
    console.log("Raw JSON output:");
    console.log(JSON.stringify(result, null, 2));

  } catch (error) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`❌ Extraction failed after ${elapsed}s`);
    console.error(error);
    process.exit(1);
  }
}

main();
