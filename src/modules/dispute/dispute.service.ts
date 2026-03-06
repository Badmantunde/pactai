import { DisputeStatus, ProjectStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../database";
import { logAudit } from "../../utils/audit";
import { config } from "../../config";
import { DIVIDER } from "../../utils/formatters";

export const OpenDisputeSchema = z.object({
  projectId: z.string(),
  actor: z.string(),
  chatId: z.string(),
});

export async function openDispute(
  input: z.infer<typeof OpenDisputeSchema>
) {
  // Freeze project
  await prisma.project.update({
    where: { id: input.projectId },
    data: { status: ProjectStatus.DISPUTE },
  });

  const dispute = await prisma.dispute.create({
    data: {
      projectId: input.projectId,
      status: DisputeStatus.OPEN,
    },
  });

  await logAudit({
    action: "DISPUTE_OPENED",
    actor: input.actor,
    projectId: input.projectId,
    chatId: input.chatId,
    details: { disputeId: dispute.id },
  });

  return dispute;
}

export async function recordStatement(
  disputeId: string,
  role: "client" | "freelancer",
  statement: string,
  actor: string,
  projectId: string,
  chatId: string
) {
  const data =
    role === "client"
      ? { clientStatement: statement }
      : { freelancerStatement: statement };

  const dispute = await prisma.dispute.update({
    where: { id: disputeId },
    data,
  });

  await logAudit({
    action: "DISPUTE_STATEMENT_RECEIVED",
    actor,
    projectId,
    chatId,
    details: { disputeId, role },
  });

  return dispute;
}

export async function resolveDispute(
  disputeId: string,
  adminNotes: string,
  actor: string,
  projectId: string,
  chatId: string
) {
  const dispute = await prisma.dispute.update({
    where: { id: disputeId },
    data: {
      status: DisputeStatus.RESOLVED,
      adminNotes,
      resolvedAt: new Date(),
    },
  });

  await prisma.project.update({
    where: { id: projectId },
    data: { status: ProjectStatus.IN_PROGRESS },
  });

  await logAudit({
    action: "DISPUTE_RESOLVED",
    actor,
    projectId,
    chatId,
    details: { disputeId, adminNotes },
  });

  return dispute;
}

export function formatDisputeOpened(projectName: string): string {
  return [
    `⚖️ DISPUTE MODE ACTIVATED`,
    DIVIDER,
    `Project: ${projectName}`,
    "",
    "All escrow releases are now FROZEN.",
    "",
    "Next steps:",
    "1. Client — please state your case.",
    "2. Freelancer — please state your case.",
    "3. Upload any supporting evidence.",
    "4. An admin has been notified.",
    "",
    "No financial actions will be processed until this dispute is resolved.",
    DIVIDER,
    `Admin notified: +${config.ADMIN_WHATSAPP_NUMBER}`,
  ].join("\n");
}
