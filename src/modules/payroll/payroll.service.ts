import { PayrollStatus } from "@prisma/client";
import { z } from "zod";
import { nanoid } from "nanoid";
import { prisma } from "../../database";
import { logAudit } from "../../utils/audit";
import {
  formatAmount,
  generateBatchCode,
  DIVIDER,
} from "../../utils/formatters";
import { config } from "../../config";
import {
  initiateBulkTransfer,
  resolveBankCode,
  type BulkTransferEntry,
} from "../payment/flutterwave.service";

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

/**
 * Process a confirmed payroll batch via Flutterwave bulk transfer.
 * Must be called after user confirms with YES.
 */
export async function processPayrollBatch(
  batchId: string,
  actor: string
): Promise<string> {
  const batch = await prisma.payrollBatch.findUniqueOrThrow({
    where: { id: batchId },
    include: { entries: true },
  });

  if (batch.status !== PayrollStatus.CONFIRMED) {
    throw new Error(
      `Payroll batch ${batch.batchCode} is not in CONFIRMED state (current: ${batch.status}).`
    );
  }

  // Mark as processing
  await prisma.payrollBatch.update({
    where: { id: batchId },
    data: { status: PayrollStatus.PROCESSING },
  });

  // Build Flutterwave bulk transfer entries
  const flwEntries: BulkTransferEntry[] = batch.entries.map((e) => ({
    bankCode: resolveBankCode(e.bankName),
    accountNumber: e.accountNumber,
    amount: e.amount / 100, // kobo → Naira
    narration: e.reference ?? `Pactai Payroll ${batch.batchCode} — ${e.recipientName}`,
    reference: `pay_${e.id}_${nanoid(6)}`,
    currency: batch.currency,
  }));

  let flwBatchId: number | null = null;
  try {
    const result = await initiateBulkTransfer(batch.batchCode, flwEntries);
    flwBatchId = result.id;

    // Save transfer references on each entry
    await Promise.all(
      flwEntries.map((fe, i) =>
        prisma.payrollEntry.update({
          where: { id: batch.entries[i].id },
          data: {
            flwTransferRef: fe.reference,
            flwTransferStatus: "NEW",
            status: "PROCESSING",
          },
        })
      )
    );

    await prisma.payrollBatch.update({
      where: { id: batchId },
      data: { status: PayrollStatus.PROCESSING, processedAt: new Date() },
    });

    await logAudit({
      action: "PAYROLL_TRANSFER_INITIATED",
      actor,
      chatId: batch.chatId,
      details: {
        batchCode: batch.batchCode,
        flwBatchId,
        count: batch.entries.length,
        totalAmount: batch.totalAmount,
        currency: batch.currency,
      },
    });

    return (
      `✅ *Payroll Processing!*\n` +
      DIVIDER + "\n" +
      `Batch: ${batch.batchCode}\n` +
      `Recipients: ${batch.entries.length}\n` +
      `Total: ${formatAmount(batch.totalAmount, batch.currency)}\n` +
      `Flutterwave Batch ID: ${flwBatchId}\n\n` +
      `Transfers are being processed. Recipients will receive funds within minutes.\n` +
      `Check status with *PAYROLL STATUS ${batch.batchCode}*.`
    );
  } catch (err) {
    // Roll back to CONFIRMED so it can be retried
    await prisma.payrollBatch.update({
      where: { id: batchId },
      data: { status: PayrollStatus.CONFIRMED },
    });

    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Payroll transfer failed: ${msg}`);
  }
}

/**
 * Confirm a DRAFT payroll batch (user said YES).
 * Returns the batch so caller can decide whether to auto-process.
 */
export async function confirmPayrollBatch(batchId: string, actor: string) {
  const batch = await prisma.payrollBatch.update({
    where: { id: batchId },
    data: { status: PayrollStatus.CONFIRMED, confirmedAt: new Date() },
    include: { entries: true },
  });

  await logAudit({
    action: "PAYROLL_CONFIRMED",
    actor,
    chatId: batch.chatId,
    details: { batchCode: batch.batchCode },
  });

  return batch;
}

/**
 * Get payroll batch status formatted for WhatsApp.
 */
export async function getPayrollStatus(batchCode: string): Promise<string> {
  const batch = await prisma.payrollBatch.findUniqueOrThrow({
    where: { batchCode },
    include: { entries: true },
  });

  const statusIcon: Record<string, string> = {
    DRAFT: "📝",
    CONFIRMED: "✅",
    PROCESSING: "⏳",
    COMPLETED: "💰",
    FAILED: "❌",
  };

  const entryIcon: Record<string, string> = {
    PENDING: "⏳",
    PROCESSING: "🔄",
    SENT: "✅",
    FAILED: "❌",
  };

  const lines = [
    `${statusIcon[batch.status] ?? "📋"} *PAYROLL STATUS: ${batch.batchCode}*`,
    DIVIDER,
    `Status: ${batch.status}`,
    `Total: ${formatAmount(batch.totalAmount, batch.currency)}`,
    `Recipients: ${batch.entries.length}`,
    "",
    "TRANSFERS:",
  ];

  for (const e of batch.entries) {
    const icon = entryIcon[e.status] ?? "⏳";
    lines.push(
      `  ${icon} ${e.recipientName} — ${formatAmount(e.amount, batch.currency)} → ${e.bankName} / ${e.accountNumber}` +
      (e.flwTransferStatus ? ` [${e.flwTransferStatus}]` : "")
    );
  }

  lines.push(DIVIDER);
  return lines.join("\n");
}

export function formatPayrollSummary(
  batch: Awaited<ReturnType<typeof createPayrollBatch>>
): string {
  const lines = [
    `💰 *PAYROLL BATCH PREVIEW*`,
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
    `💳 Payments will be sent via Flutterwave bank transfer.\n` +
    `Reply *YES* to confirm and send, or *NO* to cancel.`
  );

  return lines.join("\n");
}

// Re-export config reference for webhook server
export { config };
