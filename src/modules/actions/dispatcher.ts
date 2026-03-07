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
        logger.info({ payload }, "CREATE_PROJECT payload received from agent");
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

        // Fire off group creation + invoice PDF in the background so the
        // user gets an instant reply — heavy Baileys uploads don't block.
        const projectSnapshot = { ...project };
        const { chatId: originChatId, senderId } = ctx;

        void (async () => {
          // ── WhatsApp group ──────────────────────────────────────────────
          try {
            // Only add the client — the bot (session owner) is creator by default.
            // Adding the freelancer's own number causes "participant already in group".
            const participants: string[] = [];
            if (projectSnapshot.clientPhone) participants.push(projectSnapshot.clientPhone);
            if (
              projectSnapshot.freelancerPhone &&
              projectSnapshot.freelancerPhone !== senderId.replace(/\D/g, "")
            ) {
              participants.push(projectSnapshot.freelancerPhone);
            }

            logger.info({ participants }, "BG: Creating WhatsApp group");
            const { groupId, inviteLink } = await createWhatsAppGroup(
              `Pactai: ${projectSnapshot.name}`,
              [...new Set(participants)]
            );
            logger.info({ groupId, inviteLink }, "BG: WhatsApp group created");

            await prisma.project.update({
              where: { id: projectSnapshot.id },
              data: { groupChatId: groupId },
            });

            if (projectSnapshot.clientPhone) {
              const clientJid = `${projectSnapshot.clientPhone}@s.whatsapp.net`;
              await sendMessage(
                clientJid,
                `👋 Hi! You've been added to a project on Pactai.\n\n📋 *${projectSnapshot.name}*\n\nJoin the project group: ${inviteLink}`
              );
            }

            await sendMessage(originChatId, `🔗 Project group created successfully.`);
          } catch (err) {
            logger.error({ err }, "BG: Group creation failed");
            await sendMessage(
              originChatId,
              `⚠️ Group creation failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }

          // ── PDF invoice ─────────────────────────────────────────────────
          try {
            const invoice = await createInvoice({
              projectId: projectSnapshot.id,
              dueDate: projectSnapshot.deadline.toISOString(),
              actor: senderId,
              chatId: originChatId,
            });

            logger.info({ invoiceCode: invoice.invoiceCode }, "BG: Generating PDF invoice");
            const pdfBuffer = await generateInvoicePDF({
              invoiceCode: invoice.invoiceCode,
              projectName: projectSnapshot.name,
              clientPhone: projectSnapshot.clientPhone,
              freelancerName: projectSnapshot.freelancerName,
              freelancerAccountNumber: projectSnapshot.freelancerAccountNumber,
              freelancerBank: projectSnapshot.freelancerBank,
              amount: projectSnapshot.totalAmount,
              currency: projectSnapshot.currency,
              dueDate: invoice.dueDate,
              createdAt: invoice.createdAt,
            });

            await sendDocument(originChatId, pdfBuffer, `Invoice-${invoice.invoiceCode}.pdf`);

            if (projectSnapshot.clientPhone) {
              const clientJid = `${projectSnapshot.clientPhone}@s.whatsapp.net`;
              await sendDocument(clientJid, pdfBuffer, `Invoice-${invoice.invoiceCode}.pdf`);
            }

            logger.info({ invoiceCode: invoice.invoiceCode }, "BG: Invoice PDF sent");
          } catch (err) {
            logger.error({ err }, "BG: Invoice generation/send failed");
            await sendMessage(
              originChatId,
              `⚠️ Invoice PDF failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        })();

        return `✅ Project *${project.name}* created!\n⏳ Sending invoice PDF and creating group chat in the background...`;
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

        // Generate and send PDF to creator and client
        let pdfInfo = "";
        try {
          logger.info({ invoiceCode: invoice.invoiceCode }, "Generating PDF invoice");
          const pdfBuffer = await generateInvoicePDF({
            invoiceCode: invoice.invoiceCode,
            projectName: project.name,
            clientPhone: project.clientPhone,
            freelancerName: project.freelancerName,
            freelancerAccountNumber: project.freelancerAccountNumber,
            freelancerBank: project.freelancerBank,
            amount: invoice.amount,
            currency: invoice.currency,
            dueDate: invoice.dueDate,
            createdAt: invoice.createdAt,
          });

          await sendDocument(ctx.chatId, pdfBuffer, `Invoice-${invoice.invoiceCode}.pdf`);

          if (project.clientPhone) {
            const clientJid = `${project.clientPhone.replace(/\D/g, "")}@s.whatsapp.net`;
            await sendDocument(clientJid, pdfBuffer, `Invoice-${invoice.invoiceCode}.pdf`);
          }

          pdfInfo = `\n🧾 Invoice ${invoice.invoiceCode} sent as PDF.`;
        } catch (err) {
          logger.error({ err }, "Invoice PDF generation/send failed");
          pdfInfo = `\n⚠️ PDF send failed: ${err instanceof Error ? err.message : String(err)}`;
        }

        return formatInvoicePreview(
          invoice,
          project.name,
          project.clientPhone,
          project.freelancerName
        ) + pdfInfo;
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
