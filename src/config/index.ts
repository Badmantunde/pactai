import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid URL"),
  REDIS_URL: z.string().url("REDIS_URL must be a valid URL"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  WHATSAPP_PHONE_NUMBER: z.string().min(1, "WHATSAPP_PHONE_NUMBER is required"),
  ADMIN_WHATSAPP_NUMBER: z.string().min(1, "ADMIN_WHATSAPP_NUMBER is required"),
  // Flutterwave
  FLUTTERWAVE_SECRET_KEY: z.string().min(1, "FLUTTERWAVE_SECRET_KEY is required"),
  FLUTTERWAVE_PUBLIC_KEY: z.string().min(1, "FLUTTERWAVE_PUBLIC_KEY is required"),
  FLUTTERWAVE_WEBHOOK_SECRET: z.string().min(1, "FLUTTERWAVE_WEBHOOK_SECRET is required"),
  // Public URL of this server (used for payment redirect & webhook registration)
  APP_BASE_URL: z.string().url("APP_BASE_URL must be a valid URL"),
  // HTTP port for webhook server
  PORT: z.coerce.number().default(3000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌  Invalid environment variables:");
  parsed.error.issues.forEach((issue) => {
    console.error(`   ${issue.path.join(".")}: ${issue.message}`);
  });
  process.exit(1);
}

export const config = parsed.data;
