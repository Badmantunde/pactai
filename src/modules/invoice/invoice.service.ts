import { InvoiceStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../database";
import { logAudit } from "../../utils/audit";
import {
  formatAmount,
  formatDate,
  generateInvoiceCode,
  DIVIDER,
} from "../../utils/formatters";

export const CreateInvoiceSchema = z.object({
  projectId: z.string(),
  milestoneId: z.string().optional(),
  dueDate: z.string(), // ISO date
  paymentLink: z.string().url().optional(),
  actor: z.string(),
  chatId: z.string(),
});

export type CreateInvoiceInput = z.infer<typeof CreateInvoiceSchema>;

export async function createInvoice(input: CreateInvoiceInput) {
  const validated = CreateInvoiceSchema.parse(input);

  const project = await prisma.project.findUniqueOrThrow({
    where: { id: validated.projectId },
    include: { milestones: true },
  });

  let amount = project.totalAmount;
  let isMilestone = false;

  if (validated.milestoneId) {
    const milestone = project.milestones.find(
      (m) => m.id === validated.milestoneId
    );
    if (!milestone) throw new Error("Milestone not found on project");
    amount = milestone.amount;
    isMilestone = true;
  }

  const invoiceCode = generateInvoiceCode();

  const invoice = await prisma.invoice.create({
    data: {
      invoiceCode,
      projectId: validated.projectId,
      amount,
      currency: project.currency,
      isMilestone,
      milestoneId: validated.milestoneId ?? null,
      dueDate: new Date(validated.dueDate),
      paymentLink: validated.paymentLink ?? null,
      status: InvoiceStatus.DRAFT,
    },
  });

  await logAudit({
    action: "INVOICE_CREATED",
    actor: validated.actor,
    projectId: validated.projectId,
    chatId: validated.chatId,
    details: { invoiceCode, amount, currency: project.currency },
  });

  return invoice;
}

export function formatInvoicePreview(
  invoice: Awaited<ReturnType<typeof createInvoice>>,
  projectName: string,
  clientPhone: string,
  freelancerName: string
): string {
  return [
    `🧾 INVOICE PREVIEW`,
    DIVIDER,
    `Invoice ID:   ${invoice.invoiceCode}`,
    `Project:      ${projectName}`,
    `Client:       +${clientPhone}`,
    `Freelancer:   ${freelancerName}`,
    `Type:         ${invoice.isMilestone ? "Milestone" : "Full Payment"}`,
    `Amount:       ${formatAmount(invoice.amount, invoice.currency)}`,
    `Due Date:     ${formatDate(invoice.dueDate)}`,
    `Payment Link: ${invoice.paymentLink ?? "[To be added]"}`,
    `Status:       ⏳ ${invoice.status}`,
    DIVIDER,
    "Reply YES to send this invoice, or NO to cancel.",
  ].join("\n");
}
