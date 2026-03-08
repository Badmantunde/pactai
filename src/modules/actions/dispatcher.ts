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
  initiateEscrowFunding,
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
  confirmPayrollBatch,
  processPayrollBatch,
  getPayrollStatus,
  formatPayrollSummary,
} from "../payroll/payroll.service";
import {
  addWalletAccount,
  removeWalletAccount,
  setDefaultAccount,
  getWallet,
  formatWallet,
} from "../wallet/wallet.service";
import { prisma } from "../../database";
import { formatAmount, formatDate, DIVIDER } from "../../utils/formatters";

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

        // Run group creation and PDF invoice in parallel — both fire-and-forget.
        const projectSnapshot = { ...project };
        const { chatId: originChatId, senderId } = ctx;
        const clientJid = projectSnapshot.clientPhone
          ? `${projectSnapshot.clientPhone}@s.whatsapp.net`
          : null;

        // ── Group creation (independent, fast path) ───────────────────────────
        void (async () => {
          try {
            const phones = [...new Set([
              senderId.replace(/\D/g, ""),
              projectSnapshot.clientPhone,
              projectSnapshot.freelancerPhone,
            ].filter(Boolean) as string[])];

            const { groupId, inviteLink } = await createWhatsAppGroup(
              `Pactai: ${projectSnapshot.name}`,
              phones
            );

            // Save group ID to project and create a session for the group
            // so the AI has full project memory when group messages come in
            await Promise.all([
              prisma.project.update({
                where: { id: projectSnapshot.id },
                data: { groupChatId: groupId },
              }),
              prisma.chatSession.upsert({
                where: { chatId: groupId },
                create: { chatId: groupId, state: "IDLE", projectId: projectSnapshot.id },
                update: { projectId: projectSnapshot.id },
              }),
            ]);

            const linkMsg =
              `🔗 *Your project group is ready!*\n\n` +
              `📋 *${projectSnapshot.name}*\n` +
              `👤 Freelancer: ${projectSnapshot.freelancerName}\n` +
              `👤 Client: ${projectSnapshot.clientName ?? `+${projectSnapshot.clientPhone}`}\n\n` +
              `Tap to join: ${inviteLink}`;

            // Send invite link to BOTH parties in parallel.
            // Use originChatId for the freelancer (their private bot chat).
            await Promise.all([
              sendMessage(originChatId, linkMsg),
              clientJid
                ? sendMessage(
                    clientJid,
                    `👋 Hi${projectSnapshot.clientName ? ` ${projectSnapshot.clientName}` : ""}! ` +
                    `You've been invited to a Pactai project.\n\n${linkMsg}`
                  )
                : Promise.resolve(),
            ]);

            // Post a full project brief inside the group so the AI acts as moderator
            const tools = projectSnapshot.toolsRequired?.length
              ? `\n\n🛠️ *Tools & Deliverables:*\n${projectSnapshot.toolsRequired.map((t) => `  • ${t}`).join("\n")}`
              : "";

            const escrowNote = projectSnapshot.escrowRequired
              ? `\n\n⚠️ *Escrow Required* — Client must fund escrow before work begins. Reply *FUND ESCROW* to proceed.`
              : "";

            const groupBrief =
              `🤖 *Pactai — AI Project Moderator*\n` +
              `${DIVIDER}\n` +
              `📋 *${projectSnapshot.name}*\n` +
              `👤 Freelancer: ${projectSnapshot.freelancerName}\n` +
              `👤 Client: ${projectSnapshot.clientName ?? `+${projectSnapshot.clientPhone}`}\n` +
              `💰 Amount: ${formatAmount(projectSnapshot.totalAmount, projectSnapshot.currency)}\n` +
              `📅 Deadline: ${formatDate(projectSnapshot.deadline)}\n` +
              `💳 Payment: ${projectSnapshot.paymentType}` +
              tools +
              escrowNote +
              `\n${DIVIDER}\n` +
              `I'll moderate this project from start to payment.\n\n` +
              `*Freelancer* — when ready to begin, type:\n  📌 *START PROJECT*\n\n` +
              `*Client* — once work is delivered, type:\n  ✅ *APPROVE* to release payment\n  🔄 *REQUEST REVISION* to ask for changes`;

            // Let the group settle before posting
            await new Promise((r) => setTimeout(r, 2000));
            await sendMessage(groupId, groupBrief);

            logger.info({ groupId }, "BG: Group created, brief posted, links sent");
          } catch (err) {
            logger.error({ err }, "BG: Group creation failed");
            await sendMessage(
              originChatId,
              `⚠️ Group creation failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        })();

        // ── PDF invoice (independent, runs in parallel with group creation) ────
        void (async () => {
          try {
            const invoice = await createInvoice({
              projectId: projectSnapshot.id,
              dueDate: projectSnapshot.deadline.toISOString(),
              actor: senderId,
              chatId: originChatId,
            });

            const pdfBuffer = await generateInvoicePDF({
              invoiceCode: invoice.invoiceCode,
              projectName: projectSnapshot.name,
              clientName: projectSnapshot.clientName,
              clientPhone: projectSnapshot.clientPhone,
              freelancerName: projectSnapshot.freelancerName,
              freelancerAccountNumber: projectSnapshot.freelancerAccountNumber,
              freelancerBank: projectSnapshot.freelancerBank,
              amount: projectSnapshot.totalAmount,
              currency: projectSnapshot.currency,
              dueDate: invoice.dueDate,
              createdAt: invoice.createdAt,
              toolsRequired: projectSnapshot.toolsRequired,
            });

            // Send PDF to both parties in parallel
            await Promise.all([
              sendDocument(originChatId, pdfBuffer, `Invoice-${invoice.invoiceCode}.pdf`),
              clientJid
                ? sendDocument(clientJid, pdfBuffer, `Invoice-${invoice.invoiceCode}.pdf`)
                : Promise.resolve(),
            ]);

            logger.info({ invoiceCode: invoice.invoiceCode }, "BG: Invoice PDF sent");
          } catch (err) {
            logger.error({ err }, "BG: Invoice PDF failed");
            await sendMessage(
              originChatId,
              `⚠️ Invoice PDF failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        })();

        return `✅ Project *${project.name}* created!\n⏳ Creating group chat and sending invoice PDF in the background...`;
      }

      case "CREATE_INVOICE": {
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

        let pdfInfo = "";
        try {
          const pdfBuffer = await generateInvoicePDF({
            invoiceCode: invoice.invoiceCode,
            projectName: project.name,
            clientName: project.clientName,
            clientPhone: project.clientPhone,
            freelancerName: project.freelancerName,
            freelancerAccountNumber: project.freelancerAccountNumber,
            freelancerBank: project.freelancerBank,
            amount: invoice.amount,
            currency: invoice.currency,
            dueDate: invoice.dueDate,
            createdAt: invoice.createdAt,
            toolsRequired: project.toolsRequired,
          });

          await sendDocument(ctx.chatId, pdfBuffer, `Invoice-${invoice.invoiceCode}.pdf`);

          if (project.clientPhone) {
            const clientJid = `${project.clientPhone}@s.whatsapp.net`;
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

      // ── Wallet actions ────────────────────────────────────────────────────────
      case "ADD_WALLET_ACCOUNT": {
        const { accountNumber, bankName, accountName, setDefault } = payload as {
          accountNumber: string;
          bankName: string;
          accountName?: string;
          setDefault?: boolean;
        };
        const phone = ctx.senderId.replace(/\D/g, "");
        const account = await addWalletAccount(
          phone,
          accountNumber,
          bankName,
          accountName,
          setDefault ?? false,
          ctx.chatId
        );
        return (
          `✅ Account saved to your wallet!\n` +
          DIVIDER + "\n" +
          `Bank: ${account.bankName}\n` +
          `Account: ${account.accountNumber}` +
          (account.accountName ? `\nName: ${account.accountName}` : "") +
          (account.isDefault ? "\n✅ Set as default" : "")
        );
      }

      case "REMOVE_WALLET_ACCOUNT": {
        const { accountNumber } = payload as { accountNumber: string };
        const phone = ctx.senderId.replace(/\D/g, "");
        await removeWalletAccount(phone, accountNumber, ctx.chatId);
        return `🗑️ Account ${accountNumber} removed from your wallet.`;
      }

      case "SET_DEFAULT_ACCOUNT": {
        const { accountNumber } = payload as { accountNumber: string };
        const phone = ctx.senderId.replace(/\D/g, "");
        await setDefaultAccount(phone, accountNumber);
        return `✅ Account ${accountNumber} is now your default payout account.`;
      }

      case "VIEW_WALLET": {
        const phone = ctx.senderId.replace(/\D/g, "");
        const accounts = await getWallet(phone);
        return formatWallet(accounts);
      }

      case "VIEW_BALANCE": {
        const phone = ctx.senderId.replace(/\D/g, "");
        const projects = await prisma.project.findMany({
          where: {
            OR: [
              { clientPhone: phone },
              { freelancerPhone: phone },
            ],
            status: { in: ["ACTIVE", "FUNDED", "IN_PROGRESS", "PENDING_APPROVAL"] },
          },
          include: { escrow: true },
        });

        if (projects.length === 0) {
          return "💰 No active projects with escrow found.";
        }

        const lines = ["💰 ESCROW BALANCES", DIVIDER];
        for (const p of projects) {
          if (p.escrow) {
            const locked = p.escrow.amount - p.escrow.amountReleased;
            lines.push(
              `📋 *${p.name}*\n` +
              `   Total: ${formatAmount(p.escrow.amount, p.escrow.currency)}\n` +
              `   Released: ${formatAmount(p.escrow.amountReleased, p.escrow.currency)}\n` +
              `   Locked: ${formatAmount(locked, p.escrow.currency)}\n` +
              `   Status: ${p.escrow.status}`
            );
          }
        }
        lines.push(DIVIDER);
        return lines.join("\n");
      }

      case "FUND_ESCROW": {
        const projectId = payload.projectId as string;
        // Generate a Flutterwave payment link; actual funding happens via webhook
        const { link, amount, currency } = await initiateEscrowFunding(
          projectId,
          ctx.senderId,
          ctx.chatId
        );
        return (
          `💳 *Pay to Fund Escrow*\n` +
          DIVIDER + "\n" +
          `Amount: ${formatAmount(amount, currency)}\n\n` +
          `Click the link below to pay securely via Flutterwave:\n` +
          `👉 ${link}\n\n` +
          `Once payment is confirmed, escrow will be locked automatically and work can begin.`
        );
      }

      case "FUND_ESCROW_CONFIRMED": {
        // Called internally when webhook confirms payment (not by the agent)
        const projectId = payload.projectId as string;
        const escrow = await fundEscrow(projectId, ctx.senderId, ctx.chatId);
        return `🔒 Escrow funded — ${formatAmount(escrow.amount, escrow.currency)} locked.`;
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
        return `💰 Milestone escrow released — ${formatAmount(escrow.amountReleased, escrow.currency)} of ${formatAmount(escrow.amount, escrow.currency)} paid out.`;
      }

      case "RELEASE_ESCROW_FULL": {
        const projectId = payload.projectId as string;
        const escrow = await releaseFullEscrow(projectId, ctx.senderId, ctx.chatId);
        return `💰 Full escrow released — ${formatAmount(escrow.amount, escrow.currency)} paid out. Project marked COMPLETED.`;
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

        // Store batch ID in session context so YES/NO confirmation knows which batch
        await prisma.chatSession.update({
          where: { chatId: ctx.chatId },
          data: { context: { pendingPayrollBatchId: batch.id } as object },
        });

        return formatPayrollSummary(batch);
      }

      case "CONFIRM_PAYROLL": {
        const { batchId } = payload as { batchId: string };
        const targetId = batchId || await (async () => {
          const sess = await prisma.chatSession.findUnique({ where: { chatId: ctx.chatId } });
          return (sess?.context as Record<string, string> | null)?.pendingPayrollBatchId ?? "";
        })();
        if (!targetId) return "⚠️ No pending payroll batch found.";
        await confirmPayrollBatch(targetId, ctx.senderId);
        return await processPayrollBatch(targetId, ctx.senderId);
      }

      case "PAYROLL_STATUS": {
        const { batchCode } = payload as { batchCode: string };
        if (!batchCode) return "⚠️ Please provide a batch code. Example: *PAYROLL STATUS PAY-20240101-XXXXX*";
        return await getPayrollStatus(batchCode);
      }

      case "UPDATE_PROJECT_STATUS": {
        const { projectId: statusProjectId, status: rawStatus } = payload as {
          projectId: string;
          status: string;
        };

        // Map agent-generated statuses to valid ProjectStatus enum values
        const STATUS_MAP: Record<string, string> = {
          UNDER_REVIEW: "PENDING_APPROVAL",
          REVIEW: "PENDING_APPROVAL",
          AWAITING_APPROVAL: "PENDING_APPROVAL",
          SUBMITTED: "PENDING_APPROVAL",
        };

        const VALID_STATUSES = [
          "DRAFT", "ACTIVE", "FUNDED", "IN_PROGRESS",
          "PENDING_APPROVAL", "COMPLETED", "DISPUTE", "CANCELLED",
        ];

        const resolvedStatus = STATUS_MAP[rawStatus] ?? rawStatus;
        if (!VALID_STATUSES.includes(resolvedStatus)) {
          logger.warn({ rawStatus, resolvedStatus }, "UPDATE_PROJECT_STATUS: invalid status, skipping");
          return null;
        }

        await prisma.project.update({
          where: { id: statusProjectId },
          data: { status: resolvedStatus as never },
        });
        return null;
      }

      case "UPDATE_SESSION_STATE": {
        const { state, context } = payload as {
          state: string;
          context?: Record<string, unknown>;
        };
        // Always read current context first so userName + history are never wiped
        const current = await prisma.chatSession.findUnique({
          where: { chatId: ctx.chatId },
          select: { context: true },
        });
        const currentCtx = (current?.context ?? {}) as Record<string, unknown>;
        await prisma.chatSession.update({
          where: { chatId: ctx.chatId },
          data: {
            state,
            context: {
              ...context,
              userName: currentCtx.userName,
              history: currentCtx.history,
            } as object,
          },
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
