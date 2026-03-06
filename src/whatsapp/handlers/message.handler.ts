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
  _isGroup: boolean
): Promise<void> {
  const normalizedText = text.trim().toUpperCase();

  // Check if this is a YES/NO confirmation response
  const session = await prisma.chatSession.findUnique({ where: { chatId } });

  if (session?.state === "AWAITING_CONFIRMATION" && session.context) {
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
        },
      },
    });
  }

  // Build final reply
  const parts = [agentOutput.reply, ...actionMessages].filter(Boolean);
  await sendMessage(chatId, parts.join("\n\n"));
}
