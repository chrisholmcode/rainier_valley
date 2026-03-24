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
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-20250514"),
  GOOGLE_SPREADSHEET_ID: z.string().min(1),
  GOOGLE_WORKSHEET_NAME: z.string().default("Delivery Log"),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional()
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const message = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
  throw new Error(`Invalid environment configuration:\n${message}`);
}

export const env = parsed.data;
