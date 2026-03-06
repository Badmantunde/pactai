import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { PACTAI_SYSTEM_PROMPT } from "./system-prompt";
import { logger } from "../utils/logger";
import { prisma } from "../database";

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

  // Build the context block to inject into the user message
  const contextBlock = {
    chatId,
    senderId,
    sessionState: session.state,
    sessionContext: session.context ?? {},
    projectId: session.projectId ?? null,
  };

  const userContent = `[CONTEXT]
${JSON.stringify(contextBlock, null, 2)}
[/CONTEXT]

[MESSAGE]
${message}
[/MESSAGE]`;

  let fullText = "";

  try {
    // Stream with adaptive thinking for complex financial reasoning
    const stream = client.messages.stream({
      model: "claude-opus-4-6",
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      system: PACTAI_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        fullText += event.delta.text;
      }
    }

    await stream.finalMessage();
  } catch (err) {
    logger.error({ err, chatId }, "Agent API call failed");
    return {
      reply:
        "⚠️ System Error\n\nI encountered an error processing your request. Please try again.",
      actions: [],
      requiresConfirmation: false,
    };
  }

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
