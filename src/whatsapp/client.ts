import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestWaWebVersion,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import pino from "pino";
import { logger } from "../utils/logger";

export type WASocket = ReturnType<typeof makeWASocket>;

const baileysLogger = pino({ level: "silent" });

let sock: WASocket | null = null;

/**
 * Initialize and return the WhatsApp Baileys socket.
 * Handles QR code display, reconnection, and session persistence.
 */
export async function initWhatsApp(
  onMessage: (
    chatId: string,
    senderId: string,
    text: string,
    isGroup: boolean
  ) => Promise<void>
): Promise<WASocket> {

  // Prevent multiple sockets
  if (sock) {
    logger.info("WhatsApp socket already initialized");
    return sock;
  }

  // IMPORTANT: use Railway volume path
  const { state, saveCreds } =
    await useMultiFileAuthState("/app/auth_info_baileys");

  let version: [number, number, number];

  try {
    const result = await fetchLatestWaWebVersion();
    version = result.version;
    logger.info({ version }, "Using WhatsApp Web version");
  } catch {
    version = [2, 3000, 1023230];
    logger.warn("Could not fetch WA version, using fallback");
  }

  sock = makeWASocket({
    version,
    auth: state,
    logger: baileysLogger as never,
    browser: ["Pactai", "Chrome", "120.0.0"],
    printQRInTerminal: false,
  });

  // Save session updates
  sock.ev.on("creds.update", saveCreds);

  // Connection lifecycle
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Show QR
    if (qr) {
      console.log("\n📱 Scan this QR with WhatsApp\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      logger.info("✅ WhatsApp connected successfully");
    }

    if (connection === "close") {
      const shouldReconnect =
        (lastDisconnect?.error as Boom)?.output?.statusCode !==
        DisconnectReason.loggedOut;

      logger.warn({ shouldReconnect }, "WhatsApp connection closed");

      if (shouldReconnect) {
        logger.info("Reconnecting to WhatsApp in 5 seconds...");
        setTimeout(() => {
          sock = null;
          initWhatsApp(onMessage);
        }, 5000);
      } else {
        logger.error(
          "Logged out of WhatsApp — delete auth_info_baileys and restart"
        );
      }
    }
  });

  /**
   * Incoming messages
   */
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;

      const chatId = msg.key.remoteJid ?? "";
      const senderId = msg.key.participant ?? msg.key.remoteJid ?? "";
      const isGroup = chatId.endsWith("@g.us");

      const text =
        msg.message.conversation ??
        msg.message.extendedTextMessage?.text ??
        msg.message.imageMessage?.caption ??
        msg.message.videoMessage?.caption ??
        "";

      if (!text.trim()) continue;

      try {
        await onMessage(chatId, senderId, text.trim(), isGroup);
      } catch (err) {
        logger.error({ err, chatId }, "Message handler error");
      }
    }
  });

  return sock;
}

/**
 * Send text message
 */
export async function sendMessage(to: string, text: string): Promise<void> {
  if (!sock) throw new Error("WhatsApp socket not initialized");

  await sock.sendMessage(to, { text });
}

/**
 * Send document (PDF)
 */
export async function sendDocument(
  to: string,
  buffer: Buffer,
  fileName: string
): Promise<void> {
  if (!sock) throw new Error("WhatsApp socket not initialized");

  await sock.sendMessage(to, {
    document: buffer,
    mimetype: "application/pdf",
    fileName,
  });
}

/**
 * Create WhatsApp group
 */
export async function createWhatsAppGroup(
  subject: string,
  participants: string[]
): Promise<{ groupId: string; inviteLink: string }> {
  if (!sock) throw new Error("WhatsApp socket not initialized");

  const activeSock = sock;

  const checks = await Promise.all(
    participants
      .map((p) => p.replace(/\D/g, ""))
      .filter((p) => p.length > 6)
      .map(async (clean) => {
        try {
          const results = await activeSock.onWhatsApp(clean);
          const found = results?.[0];

          if (found?.exists) return found.jid;

          logger.warn({ phone: clean }, "Phone not on WhatsApp — skipping");
          return null;
        } catch (err) {
          logger.warn(
            { phone: clean, err },
            "onWhatsApp check failed — skipping"
          );
          return null;
        }
      })
  );

  const validJids = checks.filter((jid): jid is string => jid !== null);

  if (validJids.length === 0) {
    throw new Error("No valid WhatsApp numbers found among participants.");
  }

  const result = await sock.groupCreate(subject, validJids);

  if (!result?.id) {
    throw new Error("groupCreate returned no group ID");
  }

  const groupId = result.id;

  await new Promise((r) => setTimeout(r, 2000));

  const inviteCode = await sock.groupInviteCode(groupId);

  if (!inviteCode) {
    throw new Error(`Could not get invite code for group ${groupId}`);
  }

  return {
    groupId,
    inviteLink: `https://chat.whatsapp.com/${inviteCode}`,
  };
}