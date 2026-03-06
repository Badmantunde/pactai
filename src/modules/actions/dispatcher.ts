import { AgentAction } from "../../agent";
import { logger } from "../../utils/logger";
import { createProject } from "../project/project.service";
import { createInvoice, formatInvoicePreview } from "../invoice/invoice.service";
import { generateInvoicePDF } from "../../utils/pdf";
import {
  sendMessage,
  sendDocument,
  createWhatsAppGroup,
} from "../../whatsapp/client";
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

        // Auto-create WhatsApp group for the project
        let groupInfo = "";
        try {
          const participants = [ctx.senderId];
          if (project.clientPhone) participants.push(project.clientPhone);
          if (project.freelancerPhone) participants.push(project.freelancerPhone);

          logger.info({ participants }, "Creating WhatsApp group");
          const { groupId, inviteLink } = await createWhatsAppGroup(
            `Pactai: ${project.name}`,
            [...new Set(participants)]
          );
          logger.info({ groupId, inviteLink }, "WhatsApp group created");

          await prisma.project.update({
            where: { id: project.id },
            data: { groupChatId: groupId },
          });

          // Send group invite to client
          if (project.clientPhone) {
            const clientJid = `${project.clientPhone.replace(/\D/g, "")}@s.whatsapp.net`;
            logger.info({ clientJid }, "Sending group invite to client");
            await sendMessage(
              clientJid,
              `👋 Hi! You've been added to a project with Pactai.\n\n📋 *${project.name}*\n\nJoin the project group: ${inviteLink}`
            );
          }

          groupInfo = `\n🔗 Group created — invite link sent to client.`;
        } catch (err) {
          logger.error({ err }, "Group creation failed");
          groupInfo = `\n⚠️ Group creation failed: ${err instanceof Error ? err.message : String(err)}`;
        }

        // Generate and send PDF invoice
        let invoiceInfo = "";
        try {
          const invoice = await createInvoice({
            projectId: project.id,
            dueDate: project.deadline.toISOString(),
            actor: ctx.senderId,
            chatId: ctx.chatId,
          });

          const fullProject = await prisma.project.findUniqueOrThrow({
            where: { id: project.id },
          });

          logger.info({ invoiceCode: invoice.invoiceCode }, "Generating PDF invoice");
          const pdfBuffer = await generateInvoicePDF({
            invoiceCode: invoice.invoiceCode,
            projectName: fullProject.name,
            clientPhone: fullProject.clientPhone,
            freelancerName: fullProject.freelancerName,
            freelancerAccountNumber: fullProject.freelancerAccountNumber,
            freelancerBank: fullProject.freelancerBank,
            amount: fullProject.totalAmount,
            currency: fullProject.currency,
            dueDate: invoice.dueDate,
            createdAt: invoice.createdAt,
          });

          logger.info({ chatId: ctx.chatId }, "Sending invoice PDF to creator");
          await sendDocument(ctx.chatId, pdfBuffer, `Invoice-${invoice.invoiceCode}.pdf`);

          if (project.clientPhone) {
            const clientJid = `${project.clientPhone.replace(/\D/g, "")}@s.whatsapp.net`;
            logger.info({ clientJid }, "Sending invoice PDF to client");
            await sendDocument(clientJid, pdfBuffer, `Invoice-${invoice.invoiceCode}.pdf`);
          }

          invoiceInfo = `\n🧾 Invoice ${invoice.invoiceCode} sent as PDF.`;
        } catch (err) {
          logger.error({ err }, "Invoice generation/send failed");
          invoiceInfo = `\n⚠️ Invoice failed: ${err instanceof Error ? err.message : String(err)}`;
        }

        return `✅ Project *${project.name}* created!${groupInfo}${invoiceInfo}`;
      }

      case "CREATE_INVOICE": {
        // Fall back to session projectId if agent didn't include it
        let projectId = payload.projectId as string | undefined;
        if (!projectId) {
          const sess = await prisma.chatSession.findUnique({ where: { chatId: ctx.chatId } });
          projectId = sess?.projectId ?? undefined;
        }
        if (!projectId) return "⚠️ No active project. Create a project first.";

        const invoice = await createInvoice({
          ...payload,
          projectId,
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
          data: { state, context: (context ?? {}) as object },
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
