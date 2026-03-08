import { EscrowStatus, ProjectStatus } from "@prisma/client";
import { nanoid } from "nanoid";
import { prisma } from "../../database";
import { logAudit } from "../../utils/audit";
import { formatAmount, DIVIDER } from "../../utils/formatters";
import { config } from "../../config";
import {
  createPaymentLink,
  initiateTransfer,
  resolveBankCode,
} from "../payment/flutterwave.service";

/**
 * Generate a Flutterwave payment link for the client to fund escrow.
 * The project status is NOT changed here — it changes when the webhook confirms payment.
 */
export async function initiateEscrowFunding(
  projectId: string,
  actor: string,
  chatId: string
) {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { escrow: true },
  });

  if (!project.escrow) {
    throw new Error("No escrow record found for this project. Ensure escrow is required.");
  }

  if (project.escrow.status !== "UNFUNDED") {
    throw new Error(
      `Escrow is already ${project.escrow.status}. Cannot re-initiate funding.`
    );
  }

  // Amount in major units (Naira, not kobo)
  const amountMajor = project.totalAmount / 100;

  // Build a unique tx reference
  const txRef = `escrow_${projectId}_${nanoid(8)}`;

  const clientPhone = project.clientPhone;
  const clientEmail = `client.${clientPhone}@pactai.app`; // synthetic email for Flutterwave

  const { link } = await createPaymentLink({
    txRef,
    amount: amountMajor,
    currency: project.currency,
    customerEmail: clientEmail,
    customerName: project.clientName ?? `Client +${clientPhone}`,
    customerPhone: clientPhone,
    description: `Pactai Escrow — ${project.name}`,
    redirectUrl: `${config.APP_BASE_URL}/payment-complete`,
    meta: { projectId, type: "escrow" },
  });

  // Save payment link + txRef on the escrow record
  await prisma.escrow.update({
    where: { projectId },
    data: { flwPaymentLink: link, flwTxRef: txRef },
  });

  await logAudit({
    action: "ESCROW_PAYMENT_LINK_CREATED",
    actor,
    projectId,
    chatId,
    details: { txRef, amount: amountMajor, currency: project.currency },
  });

  return { link, amount: project.totalAmount, currency: project.currency };
}

/**
 * Mark escrow as funded (called by webhook after payment confirmed).
 */
export async function fundEscrow(
  projectId: string,
  actor: string,
  chatId: string
) {
  const escrow = await prisma.escrow.update({
    where: { projectId },
    data: {
      status: EscrowStatus.FUNDED,
      fundedAt: new Date(),
    },
  });

  await prisma.project.update({
    where: { id: projectId },
    data: { status: ProjectStatus.FUNDED },
  });

  await logAudit({
    action: "ESCROW_FUNDED",
    actor,
    projectId,
    chatId,
    details: { amount: escrow.amount, currency: escrow.currency },
  });

  return escrow;
}

export async function lockEscrow(
  projectId: string,
  actor: string,
  chatId: string
) {
  const escrow = await prisma.escrow.update({
    where: { projectId },
    data: {
      status: EscrowStatus.FUNDED,
      lockedAt: new Date(),
    },
  });

  await logAudit({
    action: "ESCROW_LOCKED",
    actor,
    projectId,
    chatId,
  });

  return escrow;
}

export async function releaseMilestoneEscrow(
  projectId: string,
  milestoneId: string,
  actor: string,
  chatId: string
) {
  // Safety check: project must not be in dispute
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { escrow: true },
  });

  if (project.status === ProjectStatus.DISPUTE) {
    throw new Error(
      "⚖️ Cannot release escrow — project is currently in DISPUTE mode."
    );
  }

  const milestone = await prisma.milestone.findUniqueOrThrow({
    where: { id: milestoneId },
  });

  if (milestone.status !== "APPROVED") {
    throw new Error(
      "Cannot release escrow — milestone has not been approved by the client."
    );
  }

  // Initiate Flutterwave transfer to freelancer
  const transferRef = `escrow_release_${milestoneId}_${nanoid(8)}`;
  const amountMajor = milestone.amount / 100;

  let transferResult = null;
  if (project.freelancerAccountNumber && project.freelancerBank) {
    const bankCode = resolveBankCode(project.freelancerBank);
    try {
      transferResult = await initiateTransfer({
        accountNumber: project.freelancerAccountNumber,
        bankCode,
        amount: amountMajor,
        currency: project.currency,
        narration: `Pactai: ${project.name} — Milestone ${milestone.title}`,
        reference: transferRef,
        callbackUrl: `${config.APP_BASE_URL}/webhooks/flutterwave`,
      });
    } catch (err) {
      // Log but don't block — admin can manually retry
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Transfer initiation failed: ${msg}. Contact admin.`);
    }
  }

  const updatedMilestone = await prisma.milestone.update({
    where: { id: milestoneId },
    data: { status: "RELEASED", releasedAt: new Date() },
  });

  const newAmountReleased =
    (project.escrow?.amountReleased ?? 0) + milestone.amount;
  const totalEscrow = project.escrow?.amount ?? project.totalAmount;
  const newStatus =
    newAmountReleased >= totalEscrow
      ? EscrowStatus.FULLY_RELEASED
      : EscrowStatus.PARTIALLY_RELEASED;

  const escrow = await prisma.escrow.update({
    where: { projectId },
    data: {
      amountReleased: newAmountReleased,
      status: newStatus,
      lastReleasedAt: new Date(),
      fullyReleasedAt:
        newStatus === EscrowStatus.FULLY_RELEASED ? new Date() : null,
      flwTransferRef: transferResult?.reference ?? transferRef,
    },
  });

  const auditAction =
    newStatus === EscrowStatus.FULLY_RELEASED
      ? "ESCROW_FULLY_RELEASED"
      : "ESCROW_PARTIALLY_RELEASED";

  await logAudit({
    action: auditAction,
    actor,
    projectId,
    chatId,
    details: {
      milestoneId,
      milestoneTitle: milestone.title,
      amountReleased: milestone.amount,
      currency: project.currency,
      totalReleased: newAmountReleased,
      transferRef,
    },
  });

  return { escrow, milestone: updatedMilestone };
}

export async function releaseFullEscrow(
  projectId: string,
  actor: string,
  chatId: string
) {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { escrow: true },
  });

  if (project.status === ProjectStatus.DISPUTE) {
    throw new Error(
      "⚖️ Cannot release escrow — project is currently in DISPUTE mode."
    );
  }

  // Initiate Flutterwave transfer to freelancer
  const transferRef = `escrow_release_full_${projectId}_${nanoid(8)}`;
  const amountMajor = project.totalAmount / 100;

  if (project.freelancerAccountNumber && project.freelancerBank) {
    const bankCode = resolveBankCode(project.freelancerBank);
    try {
      await initiateTransfer({
        accountNumber: project.freelancerAccountNumber,
        bankCode,
        amount: amountMajor,
        currency: project.currency,
        narration: `Pactai: ${project.name} — Full Payment`,
        reference: transferRef,
        callbackUrl: `${config.APP_BASE_URL}/webhooks/flutterwave`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Transfer initiation failed: ${msg}. Contact admin.`);
    }
  }

  const escrow = await prisma.escrow.update({
    where: { projectId },
    data: {
      status: EscrowStatus.FULLY_RELEASED,
      amountReleased: project.totalAmount,
      lastReleasedAt: new Date(),
      fullyReleasedAt: new Date(),
      flwTransferRef: transferRef,
    },
  });

  await prisma.project.update({
    where: { id: projectId },
    data: { status: ProjectStatus.COMPLETED },
  });

  await logAudit({
    action: "ESCROW_FULLY_RELEASED",
    actor,
    projectId,
    chatId,
    details: {
      amount: project.totalAmount,
      currency: project.currency,
      transferRef,
    },
  });

  return escrow;
}

export function formatEscrowStatus(
  status: EscrowStatus,
  amount: number,
  released: number,
  currency: string
): string {
  const icons: Record<EscrowStatus, string> = {
    UNFUNDED: "⏳",
    FUNDED: "🔒",
    PARTIALLY_RELEASED: "💰",
    FULLY_RELEASED: "✅",
  };

  return [
    `${icons[status]} ESCROW STATUS: ${status}`,
    DIVIDER,
    `Total:    ${formatAmount(amount, currency)}`,
    `Released: ${formatAmount(released, currency)}`,
    `Locked:   ${formatAmount(amount - released, currency)}`,
  ].join("\n");
}
