/**
 * Flutterwave payment service
 * - createPaymentLink: generates hosted checkout link for escrow funding
 * - initiateTransfer: sends money to a Nigerian bank account (escrow release / payroll)
 * - verifyTransaction: checks payment status by tx ref
 * - verifyWebhookSignature: validates incoming webhook hash
 */

import axios from "axios";
import { config } from "../../config";
import { logger } from "../../utils/logger";

const FLW_BASE = "https://api.flutterwave.com/v3";

function headers() {
  return {
    Authorization: `Bearer ${config.FLUTTERWAVE_SECRET_KEY}`,
    "Content-Type": "application/json",
  };
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FlwPaymentLinkInput {
  txRef: string;          // unique reference for this transaction
  amount: number;         // in major currency unit (e.g. Naira, not kobo)
  currency: string;       // NGN | USD | GHS …
  customerEmail: string;
  customerName: string;
  customerPhone: string;
  description: string;    // e.g. "Pactai Escrow — Project Name"
  redirectUrl: string;    // where to send the client after payment
  meta?: Record<string, string>;
}

export interface FlwTransferInput {
  accountNumber: string;
  bankCode: string;       // Flutterwave bank code (e.g. "044" for Access Bank)
  amount: number;         // in major unit (Naira)
  currency: string;
  narration: string;
  reference: string;      // unique debit reference
  callbackUrl?: string;
}

export interface FlwTransferResult {
  id: number;
  reference: string;
  status: string;
  message: string;
}

export interface FlwPaymentLinkResult {
  link: string;
  txRef: string;
}

// ─── Bank code lookup (common Nigerian banks) ─────────────────────────────────

const BANK_CODE_MAP: Record<string, string> = {
  "access bank": "044",
  "access": "044",
  "zenith bank": "057",
  "zenith": "057",
  "gtbank": "058",
  "guaranty trust bank": "058",
  "gt bank": "058",
  "first bank": "011",
  "first bank of nigeria": "011",
  "uba": "033",
  "united bank for africa": "033",
  "union bank": "032",
  "sterling bank": "232",
  "stanbic ibtc": "221",
  "fidelity bank": "070",
  "fcmb": "214",
  "first city monument bank": "214",
  "wema bank": "035",
  "polaris bank": "076",
  "keystone bank": "082",
  "ecobank": "050",
  "heritage bank": "030",
  "jaiz bank": "301",
  "providus bank": "101",
  "opay": "100004",
  "palmpay": "100033",
  "moniepoint": "50515",
  "kuda bank": "50211",
  "kuda": "50211",
};

export function resolveBankCode(bankName: string): string {
  const key = bankName.toLowerCase().trim();
  return BANK_CODE_MAP[key] ?? "000"; // fallback — Flutterwave will reject invalid codes
}

// ─── Create hosted payment link ───────────────────────────────────────────────

export async function createPaymentLink(
  input: FlwPaymentLinkInput
): Promise<FlwPaymentLinkResult> {
  const body = {
    tx_ref: input.txRef,
    amount: input.amount,
    currency: input.currency,
    redirect_url: input.redirectUrl,
    customer: {
      email: input.customerEmail,
      name: input.customerName,
      phonenumber: input.customerPhone,
    },
    customizations: {
      title: "Pactai Escrow",
      description: input.description,
      logo: "https://pactai.app/logo.png",
    },
    meta: input.meta ?? {},
  };

  const res = await axios.post<{
    status: string;
    data: { link: string };
  }>(`${FLW_BASE}/payments`, body, { headers: headers() });

  if (res.data.status !== "success") {
    throw new Error(`Flutterwave payment link failed: ${JSON.stringify(res.data)}`);
  }

  logger.info({ txRef: input.txRef }, "Flutterwave payment link created");
  return { link: res.data.data.link, txRef: input.txRef };
}

// ─── Initiate bank transfer ───────────────────────────────────────────────────

export async function initiateTransfer(
  input: FlwTransferInput
): Promise<FlwTransferResult> {
  const body = {
    account_bank: input.bankCode,
    account_number: input.accountNumber,
    amount: input.amount,
    narration: input.narration,
    currency: input.currency,
    reference: input.reference,
    callback_url: input.callbackUrl,
    debit_currency: input.currency,
  };

  const res = await axios.post<{
    status: string;
    message: string;
    data: { id: number; reference: string; status: string };
  }>(`${FLW_BASE}/transfers`, body, { headers: headers() });

  if (res.data.status !== "success") {
    throw new Error(`Flutterwave transfer failed: ${res.data.message}`);
  }

  logger.info({ reference: input.reference, id: res.data.data.id }, "Flutterwave transfer initiated");

  return {
    id: res.data.data.id,
    reference: res.data.data.reference,
    status: res.data.data.status,
    message: res.data.message,
  };
}

// ─── Verify transaction ───────────────────────────────────────────────────────

export async function verifyTransaction(txRef: string): Promise<{
  verified: boolean;
  amount: number;
  currency: string;
  status: string;
  flwRef: string;
}> {
  const res = await axios.get<{
    status: string;
    data: {
      status: string;
      amount: number;
      currency: string;
      flw_ref: string;
    };
  }>(`${FLW_BASE}/transactions/verify_by_reference?tx_ref=${txRef}`, {
    headers: headers(),
  });

  const d = res.data.data;
  return {
    verified: d.status === "successful",
    amount: d.amount,
    currency: d.currency,
    status: d.status,
    flwRef: d.flw_ref,
  };
}

// ─── Webhook signature verification ──────────────────────────────────────────

export function verifyWebhookSignature(
  _body: string,
  receivedHash: string
): boolean {
  // Flutterwave sends the raw secret as the verif-hash header — NOT an HMAC digest.
  // Simply compare the received value to our stored secret.
  return receivedHash === config.FLUTTERWAVE_WEBHOOK_SECRET;
}

// ─── Bulk transfer (payroll) ──────────────────────────────────────────────────

export interface BulkTransferEntry {
  bankCode: string;
  accountNumber: string;
  amount: number;         // in major unit
  narration: string;
  reference: string;
  currency: string;
}

export async function initiateBulkTransfer(
  title: string,
  entries: BulkTransferEntry[]
): Promise<{ id: number; status: string }> {
  const bulk_data = entries.map((e) => ({
    bank_code: e.bankCode,
    account_number: e.accountNumber,
    amount: e.amount,
    narration: e.narration,
    reference: e.reference,
    currency: e.currency,
  }));

  const res = await axios.post<{
    status: string;
    message: string;
    data: { id: number; status: string };
  }>(`${FLW_BASE}/bulk-transfers`, { title, bulk_data }, { headers: headers() });

  if (res.data.status !== "success") {
    throw new Error(`Flutterwave bulk transfer failed: ${res.data.message}`);
  }

  logger.info({ id: res.data.data.id, title }, "Flutterwave bulk transfer initiated");
  return { id: res.data.data.id, status: res.data.data.status };
}
