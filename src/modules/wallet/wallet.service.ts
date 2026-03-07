import { prisma } from "../../database";
import { logAudit } from "../../utils/audit";
import { DIVIDER } from "../../utils/formatters";

export interface WalletAccountData {
  id: string;
  accountNumber: string;
  bankName: string;
  accountName: string | null;
  isDefault: boolean;
}

export async function getWallet(phone: string): Promise<WalletAccountData[]> {
  return prisma.walletAccount.findMany({
    where: { phone },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
}

export async function getDefaultAccount(
  phone: string
): Promise<WalletAccountData | null> {
  const def = await prisma.walletAccount.findFirst({
    where: { phone, isDefault: true },
  });
  if (def) return def;
  return prisma.walletAccount.findFirst({ where: { phone } });
}

export async function addWalletAccount(
  phone: string,
  accountNumber: string,
  bankName: string,
  accountName: string | undefined,
  setDefault: boolean,
  chatId: string
): Promise<WalletAccountData> {
  if (setDefault) {
    await prisma.walletAccount.updateMany({
      where: { phone, isDefault: true },
      data: { isDefault: false },
    });
  }

  const existing = await prisma.walletAccount.count({ where: { phone } });

  const account = await prisma.walletAccount.upsert({
    where: { phone_accountNumber: { phone, accountNumber } },
    create: {
      phone,
      accountNumber,
      bankName,
      accountName: accountName ?? null,
      isDefault: setDefault || existing === 0,
    },
    update: {
      bankName,
      accountName: accountName ?? null,
      isDefault: setDefault || existing === 0,
    },
  });

  await logAudit({
    action: "WALLET_ACCOUNT_ADDED",
    actor: phone,
    chatId,
    details: { accountNumber, bankName },
  });

  return account;
}

export async function removeWalletAccount(
  phone: string,
  accountNumber: string,
  chatId: string
): Promise<void> {
  const account = await prisma.walletAccount.findUnique({
    where: { phone_accountNumber: { phone, accountNumber } },
  });
  if (!account) throw new Error(`Account ${accountNumber} not found in your wallet.`);

  await prisma.walletAccount.delete({
    where: { phone_accountNumber: { phone, accountNumber } },
  });

  if (account.isDefault) {
    const next = await prisma.walletAccount.findFirst({ where: { phone } });
    if (next) {
      await prisma.walletAccount.update({
        where: { id: next.id },
        data: { isDefault: true },
      });
    }
  }

  await logAudit({
    action: "WALLET_ACCOUNT_REMOVED",
    actor: phone,
    chatId,
    details: { accountNumber },
  });
}

export async function setDefaultAccount(
  phone: string,
  accountNumber: string
): Promise<void> {
  await prisma.walletAccount.updateMany({
    where: { phone },
    data: { isDefault: false },
  });
  await prisma.walletAccount.update({
    where: { phone_accountNumber: { phone, accountNumber } },
    data: { isDefault: true },
  });
}

export function formatWallet(accounts: WalletAccountData[]): string {
  if (accounts.length === 0) {
    return [
      "💳 YOUR WALLET",
      DIVIDER,
      "No accounts saved yet.",
      "",
      "To add one, say: *add account [number] [bank] [name]*",
      "e.g. add account 7039622479 Opay John Doe",
    ].join("\n");
  }

  const lines = ["💳 YOUR WALLET", DIVIDER];
  accounts.forEach((a, i) => {
    const label = `${i + 1}. ${a.bankName} — ${a.accountNumber}`;
    const name = a.accountName ? ` (${a.accountName})` : "";
    const tag = a.isDefault ? " ✅ Default" : "";
    lines.push(`${label}${name}${tag}`);
  });
  lines.push(
    "",
    DIVIDER,
    "• *add account [number] [bank] [name]* — save a new account",
    "• *remove account [number]* — delete an account",
    "• *set default [number]* — change your default payout account"
  );
  return lines.join("\n");
}
