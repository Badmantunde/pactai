import { EscrowStatus, ProjectStatus } from "@prisma/client";
import { prisma } from "../../database";
import { logAudit } from "../../utils/audit";
import { formatAmount, DIVIDER } from "../../utils/formatters";

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
  });

  if (project.status === ProjectStatus.DISPUTE) {
    throw new Error(
      "⚖️ Cannot release escrow — project is currently in DISPUTE mode."
    );
  }

  const escrow = await prisma.escrow.update({
    where: { projectId },
    data: {
      status: EscrowStatus.FULLY_RELEASED,
      amountReleased: project.totalAmount,
      lastReleasedAt: new Date(),
      fullyReleasedAt: new Date(),
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
