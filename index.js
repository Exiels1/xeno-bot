// WhatsApp bot modules
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const P = require("pino");
const fs = require("fs");
const QRCode = require("qrcode");
const express = require("express");
const http = require("http");
const { Groq } = require("groq-sdk");

const app = express();
let latestQR = null;
let xenoActive = true;

const PORT = process.env.PORT || 3000;

// Serve QR
app.get("/", async (req, res) => {
  if (!latestQR) return res.send("⚠️ QR not ready yet, please refresh.");
  const qrDataUrl = await QRCode.toDataURL(latestQR);
  res.send(`
    <html>
      <body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#111;">
        <img src="${qrDataUrl}" alt="Scan QR Code" />
      </body>
    </html>
  `);
});

// Prevent sleeping
setInterval(() => {
  http.get("http://whatsapp-bot.exiels1.repl.co");
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log("🌐 QR Page: https://whatsapp-bot.exiels1.repl.co");
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const sock = makeWASocket({ logger: P({ level: "silent" }), auth: state });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      console.log("📲 Scan your WhatsApp QR → https://whatsapp-bot.exiels1.repl.co");
    }

    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("❌ Disconnected");
      if (shouldReconnect) startSock();
    } else if (connection === "open") {
      console.log("✅ Connected to WhatsApp");
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;

    const body =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      msg.message?.documentMessage?.caption ||
      msg.message?.buttonsResponseMessage?.selectedButtonId ||
      msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
      "";

    const lower = body.toLowerCase().trim();
    const isGroup = from.endsWith("@g.us");
    const isOwner = sender === "2347016300834@s.whatsapp.net";

    console.log("Received:", lower);

    // --- TAGALL ---
    if (lower === ".tagall" && isGroup) {
      try {
        console.log("🚨 Triggering .tagall");
        const metadata = await sock.groupMetadata(from);
        const participants = metadata.participants.map((p) => p.id);

        await sock.sendMessage(from, {
          text: `🔊 *Tagging Everyone*:\n\n${participants.map((u) => `@${u.split("@")[0]}`).join(" ")}`,
          mentions: participants,
        });
      } catch (err) {
        console.error("❌ Failed to tag:", err);
      }
      return;
    }

    // --- AI Mode ---
    if (lower.startsWith("xeno ")) {
      const prompt = body.slice(5).trim();
      try {
        const chatRes = await groq.chat.completions.create({
          model: "mixtral-8x7b-32768",
          messages: [
            { role: "system", content: "You are Xeno, a moody dark-coded WhatsApp AI with street wisdom, raw attitude, and a chaotic hero vibe." },
            { role: "user", content: prompt }
          ]
        });
        const reply = chatRes.choices[0].message.content;
        await sock.sendMessage(from, { text: reply }, { quoted: msg });
      } catch (e) {
        console.error("⚠️ Groq API error:", e);
        await sock.sendMessage(from, { text: "❌ Error getting AI response." });
      }
      return;
    }

    // --- COMMANDS ---
    switch (lower) {
      case "hi":
      case "hello":
        await sock.sendMessage(from, {
          text: 'Hey 👋, I’m Xeno. Type "menu" to see what I can do.',
        });
        break;

      case "menu":
        await sock.sendMessage(from, {
          text: `📋 *Menu*:\n\n1. hi – Greet the bot\n2. about exiels – Learn about the creator\n3. help – Get usage instructions\n4. .tagall – Mention everyone (group only)\n5. xeno <your prompt> – Ask AI anything`
        });
        break;

      case "about exiels":
        await sock.sendMessage(from, {
          text: "👤 *Exiels1*: The mind behind this bot. Dark visionary. Tech rebel. Building stormy brilliance in code.",
        });
        break;

      case "help":
        await sock.sendMessage(from, {
          text: `🛠️ *Bot Help*:\n\n- Type "menu" for features\n- Use ".tagall" in group to mention all\n- Type "xeno <prompt>" to ask the AI`,
        });
        break;

      default:
        console.log(`Ignored: "${body}" from ${from}`);
        break;
    }
  });
}

startSock();
