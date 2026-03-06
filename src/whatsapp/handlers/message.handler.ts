import { runAgent } from "../../agent";
import { dispatchAction } from "../../modules/actions/dispatcher";
import { sendMessage } from "../client";
import { logger } from "../../utils/logger";
import { prisma } from "../../database";

/**
 * Main message handler — called for every incoming WhatsApp message.
 * Handles the confirmation protocol before dispatching financial actions.
 */
export async function handleMessage(
  chatId: string,
  senderId: string,
  text: string,
  isGroup: boolean
): Promise<void> {
  const normalizedText = text.trim().toUpperCase();

  // Load or create session
  const session = await prisma.chatSession.upsert({
    where: { chatId },
    create: { chatId, state: "IDLE" },
    update: {},
  });

  const sessionCtx = (session.context ?? {}) as Record<string, unknown>;

  // ── Name registration (private chats only) ──────────────────────────────
  if (!isGroup && !sessionCtx.userName) {
    if (session.state === "AWAITING_NAME") {
      const name = text.trim();
      await prisma.chatSession.update({
        where: { chatId },
        data: {
          state: "IDLE",
          context: { ...sessionCtx, userName: name } as object,
        },
      });
      await sendMessage(
        chatId,
        `Welcome, ${name}! 👋\n\nI'm *Pactai* — your financial workflow assistant.\n\nType *help* to see what I can do.`
      );
      return;
    }

    await prisma.chatSession.update({
      where: { chatId },
      data: { state: "AWAITING_NAME" },
    });
    await sendMessage(chatId, `👋 Welcome to *Pactai*!\n\nBefore we start, what's your name?`);
    return;
  }

  if (session.state === "AWAITING_CONFIRMATION" && session.context) {
    const ctx = session.context as Record<string, unknown>;

    if (normalizedText === "YES") {
      await prisma.chatSession.update({
        where: { chatId },
        data: { state: "IDLE", context: {} },
      });

      const pendingActions = ctx.pendingActions as Array<{
        type: string;
        payload: Record<string, unknown>;
      }>;

      if (pendingActions?.length) {
        const replies: string[] = ["✅ Confirmed. Processing..."];

        for (const action of pendingActions) {
          const result = await dispatchAction(action, { chatId, senderId });
          if (result) replies.push(result);
        }

        await sendMessage(chatId, replies.join("\n\n"));
      }
      return;
    }

    if (normalizedText === "NO") {
      await prisma.chatSession.update({
        where: { chatId },
        data: { state: "IDLE", context: {} },
      });
      await sendMessage(chatId, "❌ Action cancelled.");
      return;
    }
  }

  // Run the AI agent
  logger.info({ chatId, senderId }, "Processing message via agent");
  const agentOutput = await runAgent({ chatId, senderId, message: text });

  // Execute non-confirmation actions immediately
  const immediateActions = agentOutput.requiresConfirmation
    ? []
    : agentOutput.actions;

  const actionMessages: string[] = [];

  for (const action of immediateActions) {
    const result = await dispatchAction(action, { chatId, senderId });
    if (result) actionMessages.push(result);
  }

  // If confirmation required, store pending actions in session
  if (agentOutput.requiresConfirmation && agentOutput.actions.length > 0) {
    await prisma.chatSession.update({
      where: { chatId },
      data: {
        state: "AWAITING_CONFIRMATION",
        context: {
          pendingActions: agentOutput.actions,
          confirmationKey: agentOutput.confirmationKey,
        } as object,
      },
    });
  }

  // Build final reply
  const parts = [agentOutput.reply, ...actionMessages].filter(Boolean);
  await sendMessage(chatId, parts.join("\n\n"));
}
