import PDFDocument from "pdfkit";
import { formatAmount, formatDate } from "./formatters";

export interface InvoicePDFData {
  invoiceCode: string;
  projectName: string;
  clientName?: string | null;
  clientPhone: string;
  freelancerName: string;
  freelancerAccountNumber?: string | null;
  freelancerBank?: string | null;
  amount: number;
  currency: string;
  dueDate: Date;
  createdAt: Date;
  toolsRequired?: string[];
}

const BRAND = "#0f172a";
const ACCENT = "#3b82f6";
const LIGHT_BG = "#f8fafc";
const MUTED = "#64748b";
const PAGE_W = 595;
const MARGIN = 50;
const CONTENT_W = PAGE_W - MARGIN * 2; // 495

export function generateInvoicePDF(data: InvoicePDFData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 0, size: "A4" });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ── Header bar ────────────────────────────────────────────────────────────
    doc.rect(0, 0, PAGE_W, 72).fill(BRAND);

    doc
      .fontSize(14)
      .font("Helvetica-Bold")
      .fillColor("#ffffff")
      .text("PACTAI", MARGIN, 22);
    doc
      .fontSize(7)
      .font("Helvetica")
      .fillColor("#94a3b8")
      .text("Financial Workflow Agent", MARGIN, 40);

    doc
      .fontSize(18)
      .font("Helvetica-Bold")
      .fillColor("#ffffff")
      .text("INVOICE", MARGIN, 18, { align: "right", width: CONTENT_W });
    doc
      .fontSize(8)
      .font("Helvetica")
      .fillColor("#94a3b8")
      .text(data.invoiceCode, MARGIN, 42, { align: "right", width: CONTENT_W });

    // ── Accent strip ──────────────────────────────────────────────────────────
    doc.rect(0, 72, PAGE_W, 3).fill(ACCENT);

    // ── Dates row ─────────────────────────────────────────────────────────────
    doc
      .fontSize(8)
      .font("Helvetica")
      .fillColor(MUTED)
      .text(`Issue Date: ${formatDate(data.createdAt)}`, MARGIN, 90)
      .text(`Due Date:   ${formatDate(data.dueDate)}`, MARGIN, 104);

    // ── Bill To / From ────────────────────────────────────────────────────────
    const billY = 132;

    doc.rect(MARGIN, billY, 215, 80).fill(LIGHT_BG);
    doc
      .fontSize(7)
      .font("Helvetica-Bold")
      .fillColor(ACCENT)
      .text("BILL TO", MARGIN + 10, billY + 10);
    doc
      .fontSize(10)
      .font("Helvetica-Bold")
      .fillColor(BRAND)
      .text(data.clientName ?? `+${data.clientPhone}`, MARGIN + 10, billY + 24, { width: 195 });
    if (data.clientName) {
      doc
        .fontSize(9)
        .font("Helvetica")
        .fillColor(MUTED)
        .text(`+${data.clientPhone}`, MARGIN + 10, billY + 40);
    }

    doc.rect(330, billY, 215, 80).fill(LIGHT_BG);
    doc
      .fontSize(7)
      .font("Helvetica-Bold")
      .fillColor(ACCENT)
      .text("FROM", 340, billY + 10);
    doc
      .fontSize(10)
      .font("Helvetica-Bold")
      .fillColor(BRAND)
      .text(data.freelancerName, 340, billY + 24, { width: 195 });
    if (data.freelancerBank && data.freelancerAccountNumber) {
      doc
        .fontSize(9)
        .font("Helvetica")
        .fillColor(MUTED)
        .text(data.freelancerBank, 340, billY + 40)
        .text(`Acct: ${data.freelancerAccountNumber}`, 340, billY + 54);
    }

    // ── Tools / Deliverables ──────────────────────────────────────────────────
    let nextY = billY + 96;

    if (data.toolsRequired && data.toolsRequired.length > 0) {
      doc
        .fontSize(8)
        .font("Helvetica-Bold")
        .fillColor(BRAND)
        .text("TOOLS & DELIVERABLES", MARGIN, nextY);

      nextY += 14;
      data.toolsRequired.forEach((tool) => {
        doc
          .fontSize(9)
          .font("Helvetica")
          .fillColor(MUTED)
          .text(`• ${tool}`, MARGIN + 8, nextY, { width: CONTENT_W - 8 });
        nextY += 14;
      });
      nextY += 6;
    }

    // ── Table ─────────────────────────────────────────────────────────────────
    doc.rect(MARGIN, nextY, CONTENT_W, 24).fill(BRAND);
    doc
      .fontSize(8)
      .font("Helvetica-Bold")
      .fillColor("#ffffff")
      .text("DESCRIPTION", MARGIN + 10, nextY + 8)
      .text("AMOUNT", MARGIN, nextY + 8, { align: "right", width: CONTENT_W - 10 });

    const rowY = nextY + 24;
    doc.rect(MARGIN, rowY, CONTENT_W, 30).fill("#f1f5f9");
    doc
      .fontSize(10)
      .font("Helvetica")
      .fillColor(BRAND)
      .text(data.projectName, MARGIN + 10, rowY + 10, { width: 300 })
      .text(formatAmount(data.amount, data.currency), MARGIN, rowY + 10, {
        align: "right",
        width: CONTENT_W - 10,
      });

    // ── Total ─────────────────────────────────────────────────────────────────
    const totalY = rowY + 38;
    doc.rect(330, totalY, 215, 32).fill(ACCENT);
    doc
      .fontSize(9)
      .font("Helvetica-Bold")
      .fillColor("#ffffff")
      .text("TOTAL DUE", 340, totalY + 10)
      .text(formatAmount(data.amount, data.currency), 340, totalY + 10, {
        align: "right",
        width: 195,
      });

    // ── Payment instructions ───────────────────────────────────────────────────
    if (data.freelancerBank && data.freelancerAccountNumber) {
      const payY = totalY + 50;
      doc
        .fontSize(8)
        .font("Helvetica-Bold")
        .fillColor(BRAND)
        .text("PAYMENT INSTRUCTIONS", MARGIN, payY);
      doc
        .fontSize(9)
        .font("Helvetica")
        .fillColor(MUTED)
        .text(
          `Transfer to: ${data.freelancerBank} — ${data.freelancerAccountNumber} (${data.freelancerName})`,
          MARGIN,
          payY + 14,
          { width: CONTENT_W }
        );
    }

    // ── Footer ─────────────────────────────────────────────────────────────────
    doc.rect(0, 800, PAGE_W, 42).fill(BRAND);
    doc
      .fontSize(7)
      .font("Helvetica")
      .fillColor("#94a3b8")
      .text(
        "Generated by Pactai — Powered by AI financial workflows.",
        MARGIN,
        814,
        { align: "center", width: CONTENT_W }
      );

    doc.end();
  });
}
