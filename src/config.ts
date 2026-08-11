import { config as dotenvConfig } from "dotenv";
import { z } from "zod";

dotenvConfig();

const EnvSchema = z.object({
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_APP_TOKEN: z.string().min(1).optional(),
  SLACK_PORT: z.coerce.number().default(3000),
  INVENTORY_CHANNEL_ID: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),
  GOOGLE_SPREADSHEET_ID: z.string().min(1),
  GOOGLE_WORKSHEET_NAME: z.string().default("Inbound Delivery Log"),
  EOD_WORKSHEET_NAME: z.string().default("Outbound Delivery Log"),
  SUMMARY_WORKSHEET_NAME: z.string().default("Inventory Summary"),
  CORRECTIONS_LOG_WORKSHEET_NAME: z.string().default("Corrections Log"),
  EXTRACTION_TRACES_WORKSHEET_NAME: z.string().default("Extraction Traces"),
  PROMPT_SUGGESTIONS_WORKSHEET_NAME: z.string().default("Prompt Suggestions"),
  PROCESSED_EMAILS_WORKSHEET_NAME: z.string().default("Processed Emails"),
  CRATES_WORKSHEET_NAME: z.string().default("Crates"),
  // Email intake (POST /api/inbound-email). Endpoint returns 503 unless BOTH
  // are set — no half-configured state. Allowlist patterns: exact address
  // ("billing@rvfb.org"), full domain ("@charlies-produce.com"), or wildcard
  // ("*@carusos.com"). Comma-separated.
  EMAIL_INTAKE_SECRET: z.string().min(16).optional(),
  EMAIL_ALLOWED_SENDERS: z.string().optional(),
  // Silent-breakage heartbeat. CSV of `pattern:staleDays` pairs, same pattern
  // format as EMAIL_ALLOWED_SENDERS. Example:
  //   "@charlies-produce.com:10,@carusos.com:14"
  // Unset disables the heartbeat entirely.
  EMAIL_HEARTBEAT_VENDORS: z.string().optional(),
  // Public host used to build QR-code URLs on printed labels. Falls back to a
  // relative path in dev/local so testing still works.
  PUBLIC_BASE_URL: z.string().optional(),
  ADMIN_SLACK_USER_ID: z.string().min(1).optional(),
  ADMIN_EMAIL: z.string().default("chrischolm@gmail.com"),
  REVIEW_CONFIDENCE_THRESHOLD: z.coerce.number().default(0.75),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ASSISTANT_CHANNEL_ID: z.string().optional(),
  ASSISTANT_MAX_TOOL_ITERATIONS: z.coerce.number().default(8),
  VOICE_WEBHOOK_SECRET: z.string().min(1).optional(),
  VOICE_PORT: z.coerce.number().default(3001),
  DASHBOARD_TOKEN: z.string().min(1).optional(),
  CF_ACCESS_TEAM_DOMAIN: z.string().min(1).optional(),
  CF_ACCESS_AUD_TAG: z.string().min(1).optional(),
  // Tenant identity — defaults preserve RVFB behavior for backwards compatibility.
  // Set both on new tenants (e.g. TENANT_NAME="Edmonds Food Bank" TENANT_SHORT="Edmonds").
  TENANT_NAME: z.string().default("Rainier Valley Food Bank"),
  TENANT_SHORT: z.string().default("RVFB")
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const message = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
  throw new Error(`Invalid environment configuration:\n${message}`);
}

export const env = parsed.data;
