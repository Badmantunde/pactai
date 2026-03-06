import { PayrollStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../database";
import { logAudit } from "../../utils/audit";
import {
  formatAmount,
  generateBatchCode,
  DIVIDER,
} from "../../utils/formatters";

export const PayrollEntrySchema = z.object({
  recipientName: z.string().min(1),
  amount: z.number().int().positive(),
  accountNumber: z.string().min(6),
  bankName: z.string().min(1),
  reference: z.string().optional(),
});

export const CreatePayrollSchema = z.object({
  initiator: z.string(), // WhatsApp number
  chatId: z.string(),    // must be private chat (validated at handler level)
  currency: z.string().default("NGN"),
  entries: z.array(PayrollEntrySchema).min(1),
});

export type PayrollEntry = z.infer<typeof PayrollEntrySchema>;
export type CreatePayrollInput = z.infer<typeof CreatePayrollSchema>;

/**
 * Parse free-form payroll text input.
 * Expected format per line: Name — amount — account number — bank — reference(optional)
 */
export function parsePayrollText(text: string): PayrollEntry[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  const entries: PayrollEntry[] = [];
  const errors: string[] = [];

  for (const line of lines) {
    const parts = line.split(/[—\-–|,]/).map((p) => p.trim());
    if (parts.length < 4) {
      errors.push(`Invalid format: "${line}"`);
      continue;
    }

    const [recipientName, rawAmount, accountNumber, bankName, reference] =
      parts;
    const amount = Math.round(parseFloat(rawAmount.replace(/[^0-9.]/g, "")) * 100);

    if (isNaN(amount) || amount <= 0) {
      errors.push(`Invalid amount in: "${line}"`);
      continue;
    }

    entries.push({
      recipientName,
      amount,
      accountNumber,
      bankName,
      reference: reference ?? undefined,
    });
  }

  if (errors.length > 0) {
    throw new Error(`Payroll parse errors:\n${errors.join("\n")}`);
  }

  return entries;
}

/** Detect duplicate entries (same account number). */
export function detectDuplicates(entries: PayrollEntry[]): string[] {
  const seen = new Map<string, string>();
  const dupes: string[] = [];
  for (const e of entries) {
    if (seen.has(e.accountNumber)) {
      dupes.push(
        `Duplicate account ${e.accountNumber}: ${seen.get(e.accountNumber)} and ${e.recipientName}`
      );
    } else {
      seen.set(e.accountNumber, e.recipientName);
    }
  }
  return dupes;
}

export async function createPayrollBatch(input: CreatePayrollInput) {
  const validated = CreatePayrollSchema.parse(input);
  const batchCode = generateBatchCode();
  const totalAmount = validated.entries.reduce((sum, e) => sum + e.amount, 0);

  const batch = await prisma.payrollBatch.create({
    data: {
      batchCode,
      initiator: validated.initiator,
      chatId: validated.chatId,
      currency: validated.currency,
      totalAmount,
      status: PayrollStatus.DRAFT,
      entries: {
        create: validated.entries.map((e) => ({
          recipientName: e.recipientName,
          amount: e.amount,
          accountNumber: e.accountNumber,
          bankName: e.bankName,
          reference: e.reference ?? null,
        })),
      },
    },
    include: { entries: true },
  });

  await logAudit({
    action: "PAYROLL_CREATED",
    actor: validated.initiator,
    chatId: validated.chatId,
    details: {
      batchCode,
      totalAmount,
      currency: validated.currency,
      count: validated.entries.length,
    },
  });

  return batch;
}

export function formatPayrollSummary(
  batch: Awaited<ReturnType<typeof createPayrollBatch>>
): string {
  const lines = [
    `💰 PAYROLL BATCH SUMMARY`,
    DIVIDER,
    `Batch ID:    ${batch.batchCode}`,
    `Total:       ${formatAmount(batch.totalAmount, batch.currency)}`,
    `Recipients:  ${batch.entries.length}`,
    "",
    "ENTRIES:",
  ];

  for (const e of batch.entries) {
    lines.push(
      `  • ${e.recipientName} — ${formatAmount(e.amount, batch.currency)} → ${e.bankName} / ${e.accountNumber}`
    );
  }

  lines.push(
    "",
    DIVIDER,
    "Reply YES to confirm and run payroll, or NO to cancel."
  );

  return lines.join("\n");
}
