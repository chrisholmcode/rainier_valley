import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
const cache = new Map<string, string>();

export function loadPrompt(relativePath: string): string {
  const cached = cache.get(relativePath);
  if (cached !== undefined) return cached;
  const content = readFileSync(join(PROMPTS_ROOT, relativePath), "utf8").trim();
  cache.set(relativePath, content);
  return content;
}
