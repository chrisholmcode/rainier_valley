// Durable, backend-agnostic mirror of what today lands in Google Sheets.
//
// Why this exists: Sheets is the human-facing layer RVFB staff open every day,
// and we want to keep it. But as we add pantries we also want a queryable,
// per-tenant, quota-free source of truth that software can read. This module
// is the seam for that: `appendExtractionRows` (and, later, the other write
// paths in sheets.ts) mirror their rows here in addition to writing Sheets.
//
// POSTURE (proof-of-concept phase): Sheets stays the source of truth and the
// mirror is BEST-EFFORT — `mirrorSlip` swallows every error so a broken or
// misconfigured store can never block intake. The eventual flip to
// "cloud store is source of truth, Sheets is a projection" is a deliberate
// follow-up, not something that happens by turning this on.
//
// Everything is gated behind STORE_BACKEND (default "none" → prod unchanged).

import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "./config.js";

// One logical write: a slip's worth of rows, already flattened to plain
// column→value objects (NOT positional arrays), so the store is decoupled
// from SHEET_HEADERS ordering.
export interface SlipRecord {
  tenant: string; // which pantry — see resolveTenant()
  table: string; // logical table, e.g. "inbound_delivery_log"
  slipKey: string | null; // slip grouping/dedupe key (photo_url for inbound)
  rows: Record<string, unknown>[]; // one object per line item
  writtenAt: string; // ISO timestamp
  meta?: Record<string, unknown>;
}

export interface SlipStore {
  readonly backend: string;
  appendSlip(record: SlipRecord): Promise<void>;
}

// Default backend: does nothing. Keeps prod byte-for-byte identical until a
// real backend is selected via STORE_BACKEND.
class NoopStore implements SlipStore {
  readonly backend = "none";
  async appendSlip(): Promise<void> {
    /* intentionally empty */
  }
}

// Zero-dependency backend: append newline-delimited JSON to a local file.
// Not for production durability — it exists so the dual-write wiring can be
// exercised end-to-end locally (`STORE_BACKEND=file npm run dev`) without any
// cloud account. Each line is one SlipRecord.
class JsonlFileStore implements SlipStore {
  readonly backend = "file";
  private dirEnsured = false;
  constructor(private readonly filePath: string) {}

  async appendSlip(record: SlipRecord): Promise<void> {
    if (!this.dirEnsured) {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      this.dirEnsured = true;
    }
    await fs.appendFile(this.filePath, JSON.stringify(record) + "\n", "utf8");
  }
}

// GCP backend. Dynamically imported so `@google-cloud/firestore` is NOT a
// build/typecheck dependency — the package is only required at runtime when
// STORE_BACKEND=firestore. Reuses the same service-account credentials the
// Sheets client already uses (GOOGLE_SERVICE_ACCOUNT_JSON), so there's no
// second cloud identity to manage.
class FirestoreStore implements SlipStore {
  readonly backend = "firestore";
  // Firestore collection handle, resolved lazily on first write.
  private collectionPromise: Promise<{ add(data: unknown): Promise<unknown> }> | null = null;

  constructor(
    private readonly collectionName: string,
    private readonly projectId: string | undefined,
    private readonly credentials: Record<string, unknown> | undefined
  ) {}

  private async collection() {
    if (!this.collectionPromise) {
      this.collectionPromise = (async () => {
        // Non-literal specifier keeps `tsc` from resolving (and requiring) the
        // module at build time. Install `@google-cloud/firestore` before
        // setting STORE_BACKEND=firestore.
        const specifier = "@google-cloud/firestore";
        const mod: any = await import(specifier);
        const Firestore = mod.Firestore ?? mod.default?.Firestore ?? mod.default;
        const db = new Firestore({
          projectId: this.projectId,
          credentials: this.credentials
        });
        return db.collection(this.collectionName);
      })();
    }
    return this.collectionPromise;
  }

  async appendSlip(record: SlipRecord): Promise<void> {
    const col = await this.collection();
    await col.add(record);
  }
}

let singleton: SlipStore | null = null;

export function getStore(): SlipStore {
  if (singleton) return singleton;
  switch (env.STORE_BACKEND) {
    case "file":
      singleton = new JsonlFileStore(env.STORE_FILE_PATH);
      break;
    case "firestore": {
      const credentials = env.GOOGLE_SERVICE_ACCOUNT_JSON
        ? (JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as Record<string, unknown>)
        : undefined;
      const projectId =
        env.STORE_FIRESTORE_PROJECT_ID || (credentials?.project_id as string | undefined);
      singleton = new FirestoreStore(env.STORE_FIRESTORE_COLLECTION, projectId, credentials);
      break;
    }
    // case "dynamodb"/"s3": add an AWS backend here — same interface, one case.
    default:
      singleton = new NoopStore();
  }
  return singleton;
}

// Which pantry does this write belong to? Until the Slack-channel → pantry
// routing lands (see the storage-scaling discussion), everything is the
// founding tenant.
// TODO(multi-tenant): map slackChannel/workspace → pantry id.
export function resolveTenant(_slackChannel?: string): string {
  return env.STORE_TENANT_DEFAULT;
}

// Best-effort mirror. NEVER throws: a store failure logs and is swallowed so
// it can't affect the Sheets write that already succeeded. Returns true if the
// record was handed to a real backend, false if mirroring is off.
export async function mirrorSlip(record: SlipRecord): Promise<boolean> {
  const store = getStore();
  if (store.backend === "none") return false;
  try {
    await store.appendSlip(record);
    return true;
  } catch (err) {
    console.error(
      `[store:${store.backend}] mirror failed for ${record.table}/${record.slipKey ?? "?"}:`,
      err instanceof Error ? err.message : err
    );
    return false;
  }
}
