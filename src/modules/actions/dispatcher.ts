import { AgentAction } from "../../agent";
import { logger } from "../../utils/logger";
import { createProject } from "../project/project.service";
import { createInvoice, formatInvoicePreview } from "../invoice/invoice.service";
import {
  fundEscrow,
  lockEscrow,
  releaseMilestoneEscrow,
  releaseFullEscrow,
} from "../escrow/escrow.service";
import {
  openDispute,
  formatDisputeOpened,
} from "../dispute/dispute.service";
import {
  createPayrollBatch,
  formatPayrollSummary,
} from "../payroll/payroll.service";
import { prisma } from "../../database";

export interface DispatchContext {
  chatId: string;
  senderId: string;
}

/**
 * Execute a structured action returned by the agent.
 * Returns an optional extra message to append to the WhatsApp reply.
 */
export async function dispatchAction(
  action: AgentAction,
  ctx: DispatchContext
): Promise<string | null> {
  const { type, payload } = action;

  try {
    switch (type) {
      case "CREATE_PROJECT": {
        const project = await createProject({
          ...payload,
          actor: ctx.senderId,
          chatId: ctx.chatId,
        } as Parameters<typeof createProject>[0]);

        // Link this project to the chat session
        await prisma.chatSession.update({
          where: { chatId: ctx.chatId },
          data: { projectId: project.id, state: "IDLE" },
        });

        return `✅ Project created — ID: ${project.id}`;
      }

      case "CREATE_INVOICE": {
        const invoice = await createInvoice({
          ...payload,
          actor: ctx.senderId,
          chatId: ctx.chatId,
        } as Parameters<typeof createInvoice>[0]);

        const project = await prisma.project.findUniqueOrThrow({
          where: { id: invoice.projectId },
        });

        return formatInvoicePreview(
          invoice,
          project.name,
          project.clientPhone,
          project.freelancerName
        );
      }

      case "FUND_ESCROW": {
        const projectId = payload.projectId as string;
        const escrow = await fundEscrow(projectId, ctx.senderId, ctx.chatId);
        return `🔒 Escrow funded — ${escrow.amount} ${escrow.currency} locked.`;
      }

      case "LOCK_ESCROW": {
        const projectId = payload.projectId as string;
        await lockEscrow(projectId, ctx.senderId, ctx.chatId);
        return "🔒 Escrow Locked";
      }

      case "RELEASE_ESCROW_MILESTONE": {
        const { projectId, milestoneId } = payload as {
          projectId: string;
          milestoneId: string;
        };
        const { escrow } = await releaseMilestoneEscrow(
          projectId,
          milestoneId,
          ctx.senderId,
          ctx.chatId
        );
        return `💰 Milestone escrow released — ${escrow.amountReleased} of ${escrow.amount} ${escrow.currency} paid out.`;
      }

      case "RELEASE_ESCROW_FULL": {
        const projectId = payload.projectId as string;
        const escrow = await releaseFullEscrow(
          projectId,
          ctx.senderId,
          ctx.chatId
        );
        return `💰 Full escrow released — ${escrow.amount} ${escrow.currency} paid out. Project marked COMPLETED.`;
      }

      case "OPEN_DISPUTE": {
        const projectId = payload.projectId as string;
        const project = await prisma.project.findUniqueOrThrow({
          where: { id: projectId },
        });
        await openDispute({ projectId, actor: ctx.senderId, chatId: ctx.chatId });
        return formatDisputeOpened(project.name);
      }

      case "CREATE_PAYROLL_BATCH": {
        const batch = await createPayrollBatch({
          ...payload,
          initiator: ctx.senderId,
          chatId: ctx.chatId,
        } as Parameters<typeof createPayrollBatch>[0]);
        return formatPayrollSummary(batch);
      }

      case "UPDATE_PROJECT_STATUS": {
        const { projectId, status } = payload as {
          projectId: string;
          status: string;
        };
        await prisma.project.update({
          where: { id: projectId },
          data: { status: status as never },
        });
        return `✅ Project status updated to ${status}`;
      }

      case "UPDATE_SESSION_STATE": {
        const { state, context } = payload as {
          state: string;
          context?: Record<string, unknown>;
        };
        await prisma.chatSession.update({
          where: { chatId: ctx.chatId },
          data: { state, context: context ?? {} },
        });
        return null;
      }

      default:
        logger.warn({ type }, "Unknown action type — skipped");
        return null;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, type }, "Action dispatch failed");
    return `⚠️ Action failed: ${message}`;
  }
}
