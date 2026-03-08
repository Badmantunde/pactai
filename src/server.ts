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
import { formatAmount, formatDate, DIVIDER } from "./utils/formatters";

export function createServer() {
  const app = express();

  // ── Health check ────────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "pactai" });
  });

  // ── Payment redirect (primary trigger) ─────────────────────────────────────
  // After the client pays on Flutterwave, they are redirected here with:
  //   ?status=successful&tx_ref=escrow_<projectId>_<nonce>&transaction_id=<id>
  // This is MORE reliable than webhooks because it fires immediately on payment.
  app.get("/payment-complete", (req, res) => {
    const { status, tx_ref } = req.query as Record<string, string>;
    logger.info({ status, tx_ref }, "FLW payment redirect received");

    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pactai — Payment Received</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0fdf4}
.card{background:#fff;border-radius:16px;padding:40px 32px;text-align:center;max-width:400px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{color:#16a34a;font-size:2rem;margin:0 0 8px}p{color:#555;margin:8px 0}
.sub{font-size:.9rem;color:#888;margin-top:16px}</style></head>
<body><div class="card">
<h1>✅ Payment Received!</h1>
<p><strong>Escrow has been funded.</strong></p>
<p>Your project group on WhatsApp will be notified automatically.</p>
<p class="sub">You can close this page and return to WhatsApp.</p>
</div></body></html>`);

    // Process async — do not block the redirect response
    if ((status === "successful" || status === "completed") && tx_ref?.startsWith("escrow_")) {
      handleEscrowPayment(tx_ref).catch((err) => {
        logger.error({ err, tx_ref }, "Payment redirect handler error");
      });
    }
  });

  // ── Flutterwave webhook (secondary / backup trigger) ─────────────────────
  // Flutterwave also sends a POST webhook. We handle both so either path works.
  app.post(
    "/webhooks/flutterwave",
    express.raw({ type: "application/json" }),
    (req, res) => {
      const rawBody = req.body as Buffer;
      const receivedHash = req.headers["verif-hash"] as string | undefined;

      logger.info({ receivedHash: receivedHash ? "present" : "missing" }, "FLW webhook hit");

      if (!receivedHash) {
        logger.warn("FLW webhook: missing verif-hash header");
        res.status(400).send("Missing signature");
        return;
      }

      if (!verifyWebhookSignature(rawBody.toString(), receivedHash)) {
        logger.warn({ receivedHash }, "FLW webhook: invalid signature — check FLUTTERWAVE_WEBHOOK_SECRET");
        res.status(401).send("Invalid signature");
        return;
      }

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(rawBody.toString()) as Record<string, unknown>;
      } catch {
        res.status(400).send("Invalid JSON");
        return;
      }

      const eventType = event["event"] as string | undefined;
      logger.info({ eventType }, "FLW webhook received");

      // Respond 200 immediately, then process async
      res.status(200).send("OK");
      handleFlwEvent(eventType ?? "", event).catch((err) => {
        logger.error({ err }, "FLW webhook handler error");
      });
    }
  );

  // Apply JSON middleware for all other routes
  app.use(express.json());

  return app;
}

// ─── Shared: handle a confirmed escrow payment by txRef ──────────────────────

async function handleEscrowPayment(txRef: string) {
  // txRef format: escrow_<projectId>_<nonce>
  const parts = txRef.split("_");
  // parts[0] = "escrow", parts[1] = projectId (no underscores in cuid)
  const projectId = parts[1];
  if (!projectId) {
    logger.warn({ txRef }, "handleEscrowPayment: cannot extract projectId from txRef");
    return;
  }

  // Load project and escrow
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { escrow: true },
  });

  if (!project || !project.escrow) {
    logger.warn({ projectId, txRef }, "handleEscrowPayment: project/escrow not found");
    return;
  }

  if (project.escrow.status !== "UNFUNDED") {
    logger.info({ projectId }, "handleEscrowPayment: escrow already funded, skipping");
    return;
  }

  // Verify with Flutterwave API to confirm the payment is genuine
  const verification = await verifyTransaction(txRef);
  if (!verification.verified) {
    logger.warn({ txRef }, "handleEscrowPayment: Flutterwave verification failed");
    return;
  }

  // Mark escrow as funded in DB
  await fundEscrow(projectId, "SYSTEM", project.groupChatId ?? projectId);

  // Save flw ref
  await prisma.escrow.update({
    where: { projectId },
    data: { flwTxRef: verification.flwRef },
  });

  const amount = formatAmount(project.totalAmount, project.currency);

  const groupAnnouncement =
    `🔒 *Escrow Funded — Project Cleared to Start!*\n` +
    DIVIDER + "\n" +
    `📋 *${project.name}*\n` +
    `👤 Freelancer: ${project.freelancerName}\n` +
    `👤 Client: ${project.clientName ?? `+${project.clientPhone}`}\n` +
    `💰 Locked in Escrow: ${amount}\n` +
    `📅 Deadline: ${formatDate(project.deadline)}\n` +
    DIVIDER + "\n\n" +
    `✅ Payment has been received and is securely locked.\n` +
    `It will be released automatically once the client approves the deliverables.\n\n` +
    `📌 *${project.freelancerName}* — you're good to go!\n` +
    `Type *START PROJECT* to officially commence work and log the start date.`;

  if (project.groupChatId) {
    await sendMessage(project.groupChatId, groupAnnouncement);
  }

  if (project.freelancerPhone) {
    await sendMessage(
      `${project.freelancerPhone}@s.whatsapp.net`,
      `🔔 *Escrow funded for "${project.name}"!*\n\n` +
      `${amount} is now locked and waiting for you.\n` +
      `Head to the project group and type *START PROJECT* to begin.`
    );
  }

  if (!project.groupChatId && project.clientPhone) {
    await sendMessage(`${project.clientPhone}@s.whatsapp.net`, groupAnnouncement);
  }

  logger.info({ projectId, txRef }, "Escrow funded and group notified");
}

// ─── Webhook event handler ───────────────────────────────────────────────────

async function handleFlwEvent(
  eventType: string,
  event: Record<string, unknown>
) {
  const data = event["data"] as Record<string, unknown> | undefined;
  if (!data) return;

  // ── Payment confirmed (escrow funding) ──────────────────────────────────────
  if (
  eventType === "charge.completed" ||
  eventType === "payment.completed"
) {
    const status = data["status"] as string;
    const txRef = data["tx_ref"] as string | undefined;

    if (status !== "successful" || !txRef) return;
    if (!txRef.startsWith("escrow_")) return;

    await handleEscrowPayment(txRef);
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
  const port = process.env.PORT ? Number(process.env.PORT) : config.PORT;

  await new Promise<void>((resolve) => {
    app.listen(port, "0.0.0.0", () => {
      logger.info({ port }, "HTTP server listening on 0.0.0.0");
      resolve();
    });
  });
}
