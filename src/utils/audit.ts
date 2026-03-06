import { AuditAction } from "@prisma/client";
import { prisma } from "../database";

interface AuditParams {
  action: AuditAction;
  actor: string;
  projectId?: string;
  chatId?: string;
  details?: Record<string, unknown>;
}

export async function logAudit(params: AuditParams): Promise<void> {
  await prisma.auditLog.create({
    data: {
      action: params.action,
      actor: params.actor,
      projectId: params.projectId ?? null,
      chatId: params.chatId ?? null,
      details: params.details ?? {},
    },
  });
}
