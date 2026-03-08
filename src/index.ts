import "./config"; // validate env vars first
import { initWhatsApp } from "./whatsapp/client";
import { handleMessage } from "./whatsapp/handlers/message.handler";
import { prisma } from "./database";
import { logger } from "./utils/logger";
import { startServer } from "./server";

async function main() {
  logger.info("Starting Pactai...");

  // Start HTTP server FIRST so Railway health check passes immediately
  await startServer();

  // Then connect to database
  await prisma.$connect();
  logger.info("Database connected");

  // Start WhatsApp (fire-and-forget so it doesn't block if QR scan is needed)
  initWhatsApp(handleMessage).catch((err) => {
    logger.error(err, "WhatsApp init failed");
  });

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
