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

  // Connect to database (retry so Railway's DB proxy has time to wake up)
  let dbReady = false;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await prisma.$connect();
      logger.info("Database connected");
      dbReady = true;
      break;
    } catch (err) {
      logger.warn({ attempt, err }, "DB connect failed, retrying in 3s...");
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!dbReady) {
    logger.error("Could not connect to database after 10 attempts — exiting");
    process.exit(1);
  }

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
