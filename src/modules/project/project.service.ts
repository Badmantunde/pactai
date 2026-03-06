import { PaymentType, ProjectStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../database";
import { logAudit } from "../../utils/audit";
import { formatAmount, formatDate, DIVIDER } from "../../utils/formatters";

export const CreateProjectSchema = z.object({
  name: z.string().min(1),
  clientPhone: z.string().min(7),
  freelancerName: z.string().min(1),
  freelancerPhone: z.string().optional(),
  totalAmount: z.number().int().positive(), // smallest currency unit
  currency: z.string().default("NGN"),
  paymentType: z.enum(["FULL", "MILESTONE"]),
  milestones: z
    .array(
      z.object({
        title: z.string(),
        amount: z.number().int().positive(),
        dueDate: z.string().optional(),
        order: z.number().int(),
      })
    )
    .optional(),
  deadline: z.string(), // ISO date string
  escrowRequired: z.boolean().default(true),
  actor: z.string(), // WhatsApp number of person creating
  chatId: z.string(),
});

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

export async function createProject(input: CreateProjectInput) {
  const validated = CreateProjectSchema.parse(input);

  const project = await prisma.project.create({
    data: {
      name: validated.name,
      clientPhone: validated.clientPhone,
      freelancerName: validated.freelancerName,
      freelancerPhone: validated.freelancerPhone,
      totalAmount: validated.totalAmount,
      currency: validated.currency,
      paymentType: validated.paymentType as PaymentType,
      deadline: new Date(validated.deadline),
      escrowRequired: validated.escrowRequired,
      status: ProjectStatus.ACTIVE,
      milestones:
        validated.paymentType === "MILESTONE" && validated.milestones
          ? {
              create: validated.milestones.map((m) => ({
                title: m.title,
                amount: m.amount,
                dueDate: m.dueDate ? new Date(m.dueDate) : null,
                order: m.order,
              })),
            }
          : undefined,
      escrow: validated.escrowRequired
        ? {
            create: {
              amount: validated.totalAmount,
              currency: validated.currency,
            },
          }
        : undefined,
    },
    include: { milestones: true, escrow: true },
  });

  await logAudit({
    action: "PROJECT_CREATED",
    actor: validated.actor,
    projectId: project.id,
    chatId: validated.chatId,
    details: {
      name: project.name,
      amount: project.totalAmount,
      currency: project.currency,
    },
  });

  return project;
}

export async function getProjectSummary(projectId: string): Promise<string> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { milestones: { orderBy: { order: "asc" } }, escrow: true },
  });

  if (!project) return "Project not found.";

  const lines: string[] = [
    `📋 PROJECT SUMMARY`,
    DIVIDER,
    `Project:     ${project.name}`,
    `Status:      ${project.status}`,
    `Client:      +${project.clientPhone}`,
    `Freelancer:  ${project.freelancerName}`,
    `Amount:      ${formatAmount(project.totalAmount, project.currency)}`,
    `Payment:     ${project.paymentType}`,
    `Deadline:    ${formatDate(project.deadline)}`,
    `Escrow:      ${project.escrowRequired ? "Yes" : "No"}`,
  ];

  if (project.escrow) {
    lines.push(`Escrow State: ${project.escrow.status}`);
  }

  if (project.milestones.length > 0) {
    lines.push("", "MILESTONES:");
    project.milestones.forEach((m) => {
      lines.push(
        `  ${m.order}. ${m.title} — ${formatAmount(m.amount, project.currency)} [${m.status}]`
      );
    });
  }

  lines.push(DIVIDER, `Project ID: ${project.id}`);
  return lines.join("\n");
}

export async function getProjectByChatId(chatId: string) {
  const session = await prisma.chatSession.findUnique({ where: { chatId } });
  if (!session?.projectId) return null;
  return prisma.project.findUnique({
    where: { id: session.projectId },
    include: { milestones: true, escrow: true },
  });
}

export async function updateProjectStatus(
  projectId: string,
  status: ProjectStatus,
  actor: string
) {
  const project = await prisma.project.update({
    where: { id: projectId },
    data: { status },
  });

  await logAudit({
    action: status === "COMPLETED" ? "PROJECT_COMPLETED" : "PROJECT_CANCELLED",
    actor,
    projectId,
    details: { newStatus: status },
  });

  return project;
}
