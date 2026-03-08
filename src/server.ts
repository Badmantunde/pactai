/**
 * Express HTTP server
 * - Hosts Flutterwave payment webhook
 * - Health check endpoint for Railway
 */

import express from "express";
import { config } from "./config";
import { logger } from "./utils/logger";
import { prisma } from "./database";
import { verifyWebhookSignature, verifyTransaction } from "./modules/payment/flutterwave.service";
import { fundEscrow } from "./modules/escrow/escrow.service";
import { sendMessage } from "./whatsapp/client";
import { formatAmount } from "./utils/formatters";

export function createServer() {
  const app = express();

  // ── Health check ────────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "pactai" });
  });

  // ── Flutterwave webhook ─────────────────────────────────────────────────────
  // Flutterwave sends the webhook as JSON with a verif-hash header.
  app.post(
    "/webhooks/flutterwave",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      const rawBody = req.body as Buffer;
      const receivedHash = req.headers["verif-hash"] as string | undefined;

      if (!receivedHash) {
        logger.warn("FLW webhook: missing verif-hash header");
        return res.status(400).send("Missing signature");
      }

      if (!verifyWebhookSignature(rawBody.toString(), receivedHash)) {
        logger.warn("FLW webhook: invalid signature");
        return res.status(401).send("Invalid signature");
      }

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(rawBody.toString()) as Record<string, unknown>;
      } catch {
        return res.status(400).send("Invalid JSON");
      }

      const eventType = event["event"] as string | undefined;
      logger.info({ eventType }, "FLW webhook received");

      try {
        await handleFlwEvent(eventType ?? "", event);
      } catch (err) {
        logger.error({ err }, "FLW webhook handler error");
      }

      // Always return 200 immediately so Flutterwave doesn't retry
      return res.status(200).send("OK");
    }
  );

  // Apply JSON middleware for all other routes
  app.use(express.json());

  return app;
}

// ─── Webhook event handler ───────────────────────────────────────────────────

async function handleFlwEvent(
  eventType: string,
  event: Record<string, unknown>
) {
  const data = event["data"] as Record<string, unknown> | undefined;
  if (!data) return;

  // ── Payment confirmed (escrow funding) ──────────────────────────────────────
  if (eventType === "charge.completed") {
    const status = data["status"] as string;
    const txRef = data["tx_ref"] as string | undefined;

    if (status !== "successful" || !txRef) return;

    // txRef format: escrow_<projectId>_<timestamp>
    if (!txRef.startsWith("escrow_")) return;

    const projectId = txRef.split("_")[1];
    if (!projectId) return;

    // Verify with Flutterwave to prevent spoofed webhooks
    const verification = await verifyTransaction(txRef);
    if (!verification.verified) {
      logger.warn({ txRef }, "FLW payment webhook: verification failed");
      return;
    }

    // Load project and escrow
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { escrow: true },
    });

    if (!project || !project.escrow) {
      logger.warn({ projectId }, "FLW webhook: project/escrow not found");
      return;
    }

    if (project.escrow.status !== "UNFUNDED") {
      logger.info({ projectId }, "FLW webhook: escrow already funded, skipping");
      return;
    }

    // Mark escrow as funded
    await fundEscrow(projectId, "SYSTEM", project.groupChatId ?? projectId);

    // Save flw ref
    await prisma.escrow.update({
      where: { projectId },
      data: { flwTxRef: verification.flwRef },
    });

    const amount = formatAmount(project.totalAmount, project.currency);
    const successMsg =
      `✅ *Escrow Funded!*\n\n` +
      `💰 ${amount} has been received and locked in escrow for *${project.name}*.\n\n` +
      `The freelancer can now begin work.\n` +
      `Type *START PROJECT* to kick things off.`;

    // Notify in group chat (if exists) or fallback to client phone
    const notifyChat = project.groupChatId
      ? project.groupChatId
      : project.clientPhone
        ? `${project.clientPhone}@s.whatsapp.net`
        : null;

    if (notifyChat) {
      await sendMessage(notifyChat, successMsg);
    }

    logger.info({ projectId, txRef }, "Escrow funded via Flutterwave webhook");
  }

  // ── Transfer status update (escrow release / payroll) ────────────────────────
  if (eventType === "transfer.completed") {
    const reference = data["reference"] as string | undefined;
    const status = data["status"] as string | undefined;

    if (!reference || !status) return;

    // Update PayrollEntry if this is a payroll transfer
    if (reference.startsWith("pay_")) {
      await prisma.payrollEntry.updateMany({
        where: { flwTransferRef: reference },
        data: {
          flwTransferStatus: status.toUpperCase(),
          status: status === "SUCCESSFUL" ? "SENT" : status === "FAILED" ? "FAILED" : "PROCESSING",
        },
      });
    }

    // Update Escrow if this is an escrow release transfer
    if (reference.startsWith("escrow_release_")) {
      await prisma.escrow.updateMany({
        where: { flwTransferRef: reference },
        data: { flwTransferRef: reference },
      });
    }

    logger.info({ reference, status }, "FLW transfer status updated");
  }
}

export async function startServer() {
  const app = createServer();
  const port = config.PORT;

  await new Promise<void>((resolve) => {
    app.listen(port, () => {
      logger.info({ port }, "HTTP server listening");
      resolve();
    });
  });
}
