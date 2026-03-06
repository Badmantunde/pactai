import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import { logger } from "../utils/logger";

export type WASocket = ReturnType<typeof makeWASocket>;

let sock: WASocket | null = null;

/**
 * Initialize and return the WhatsApp Baileys socket.
 * Handles QR code display, reconnection, and session persistence.
 */
export async function initWhatsApp(
  onMessage: (chatId: string, senderId: string, text: string, isGroup: boolean) => Promise<void>
): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: logger.child({ module: "baileys" }) as never,
  });

  // Save credentials on update
  sock.ev.on("creds.update", saveCreds);

  // Handle connection updates
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n📱 Scan this QR code with WhatsApp:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const shouldReconnect =
        (lastDisconnect?.error as Boom)?.output?.statusCode !==
        DisconnectReason.loggedOut;

      logger.warn(
        { shouldReconnect },
        "WhatsApp connection closed"
      );

      if (shouldReconnect) {
        logger.info("Reconnecting to WhatsApp...");
        initWhatsApp(onMessage);
      } else {
        logger.error("Logged out — delete auth_info_baileys/ and restart");
      }
    }

    if (connection === "open") {
      logger.info("✅ WhatsApp connected successfully");
    }
  });

  // Handle incoming messages
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue; // ignore own messages
      if (!msg.message) continue;

      const chatId = msg.key.remoteJid ?? "";
      const senderId = msg.key.participant ?? msg.key.remoteJid ?? "";
      const isGroup = chatId.endsWith("@g.us");

      const text =
        msg.message.conversation ??
        msg.message.extendedTextMessage?.text ??
        "";

      if (!text.trim()) continue;

      try {
        await onMessage(chatId, senderId, text, isGroup);
      } catch (err) {
        logger.error({ err, chatId }, "Error handling message");
      }
    }
  });

  return sock;
}

/** Send a text message via WhatsApp. */
export async function sendMessage(to: string, text: string): Promise<void> {
  if (!sock) throw new Error("WhatsApp socket not initialized");
  await sock.sendMessage(to, { text });
}
