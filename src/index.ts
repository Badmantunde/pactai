import "./config"; // validate env vars first
import { initWhatsApp } from "./whatsapp/client";
import { handleMessage } from "./whatsapp/handlers/message.handler";
import { prisma } from "./database";
import { logger } from "./utils/logger";
import { startServer } from "./server";

async function main() {
  logger.info("Starting Pactai...");

  // Verify database connection
  await prisma.$connect();
  logger.info("Database connected");

  // Start HTTP server (health check + Flutterwave webhooks)
  await startServer();

  // Start WhatsApp
  await initWhatsApp(handleMessage);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    logger.info("Shutting down...");
    await prisma.$disconnect();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    logger.info("Shutting down...");
    await prisma.$disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error(err, "Fatal startup error");
  process.exit(1);
});
