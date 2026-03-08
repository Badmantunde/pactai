import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { PACTAI_SYSTEM_PROMPT } from "./system-prompt";
import { logger } from "../utils/logger";
import { prisma } from "../database";
import { getWallet, getDefaultAccount } from "../modules/wallet/wallet.service";

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export interface AgentInput {
  chatId: string;
  senderId: string;
  message: string;
}

export interface AgentAction {
  type: string;
  payload: Record<string, unknown>;
}

export interface AgentOutput {
  reply: string;
  actions: AgentAction[];
  requiresConfirmation: boolean;
  confirmationKey?: string;
}

/**
 * Run the Pactai agent for an incoming WhatsApp message.
 * Uses claude-opus-4-6 with adaptive thinking and streaming.
 */
export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const { chatId, senderId, message } = input;

  // Load or create chat session
  const session = await prisma.chatSession.upsert({
    where: { chatId },
    create: { chatId, state: "IDLE" },
    update: {},
  });

  const ctx = (session.context ?? {}) as Record<string, unknown>;
  const history = (ctx.history ?? []) as Array<{ role: "user" | "assistant"; content: string }>;

  // Load wallet for context (phone digits only)
  const senderPhone = senderId.replace(/\D/g, "");
  const [walletAccounts, defaultAccount, escrowData, userProjects] = await Promise.all([
    getWallet(senderPhone),
    getDefaultAccount(senderPhone),
    session.projectId
      ? prisma.escrow.findUnique({ where: { projectId: session.projectId } })
      : Promise.resolve(null),
    // Load ALL projects this user is part of (as freelancer or client)
    prisma.project.findMany({
      where: {
        OR: [
          { freelancerPhone: senderPhone },
          { clientPhone: senderPhone },
        ],
        status: { notIn: ["COMPLETED", "CANCELLED"] },
      },
      include: { escrow: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  // Build context block for the current turn
  const contextBlock = {
    chatId,
    senderId,
    userName: ctx.userName ?? null,
    sessionState: session.state,
    sessionContext: { ...ctx, history: undefined, userName: undefined },
    // Active project (the one last worked on in this chat)
    activeProjectId: session.projectId ?? null,
    escrow: escrowData
      ? { status: escrowData.status, amount: escrowData.amount, amountReleased: escrowData.amountReleased }
      : null,
    // All active projects for this user
    projects: userProjects.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      clientName: p.clientName,
      clientPhone: p.clientPhone,
      totalAmount: p.totalAmount,
      currency: p.currency,
      deadline: p.deadline,
      escrowStatus: p.escrow?.status ?? null,
      isActive: p.id === session.projectId,
    })),
    wallet: {
      accounts: walletAccounts.map((a) => ({
        accountNumber: a.accountNumber,
        bankName: a.bankName,
        accountName: a.accountName,
        isDefault: a.isDefault,
      })),
      defaultAccount: defaultAccount
        ? {
            accountNumber: defaultAccount.accountNumber,
            bankName: defaultAccount.bankName,
            accountName: defaultAccount.accountName,
          }
        : null,
    },
  };

  const userContent = `[CONTEXT]
${JSON.stringify(contextBlock, null, 2)}
[/CONTEXT]

[MESSAGE]
${message}
[/MESSAGE]`;

  let fullText = "";

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: PACTAI_SYSTEM_PROMPT,
      messages: [
        ...history,
        { role: "user", content: userContent },
      ],
    });

    for (const block of response.content) {
      if (block.type === "text") {
        fullText += block.text;
      }
    }
  } catch (err) {
    logger.error({ err, chatId }, "Agent API call failed");
    return {
      reply: "⚠️ Something went wrong. Please try again.",
      actions: [],
      requiresConfirmation: false,
    };
  }

  // Persist conversation history (keep last 10 pairs = 20 messages)
  const updatedHistory = [
    ...history,
    { role: "user" as const, content: userContent },
    { role: "assistant" as const, content: fullText },
  ].slice(-20);

  await prisma.chatSession.update({
    where: { chatId },
    data: {
      context: { ...ctx, history: updatedHistory } as object,
    },
  });

  // Parse the JSON response from Claude
  const output = parseAgentOutput(fullText);
  logger.debug({ chatId, actions: output.actions }, "Agent response parsed");

  return output;
}

function parseAgentOutput(raw: string): AgentOutput {
  // Claude should return JSON — extract it even if wrapped in markdown
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ??
    raw.match(/(\{[\s\S]*\})/);

  const jsonString = jsonMatch ? jsonMatch[1].trim() : raw.trim();

  try {
    const parsed = JSON.parse(jsonString) as Partial<AgentOutput>;
    return {
      reply: parsed.reply ?? raw,
      actions: parsed.actions ?? [],
      requiresConfirmation: parsed.requiresConfirmation ?? false,
      confirmationKey: parsed.confirmationKey,
    };
  } catch {
    // If Claude returned plain text instead of JSON, wrap it
    return {
      reply: raw,
      actions: [],
      requiresConfirmation: false,
    };
  }
}
