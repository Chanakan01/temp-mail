import express from "express";
import http from "http";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import { Server as SocketIOServer } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----- MONGOOSE MODELS -----
const mailboxSchema = new mongoose.Schema({
  address: { type: String, unique: true, required: true }, // user123@domain
  userId: { type: String, default: null }, // reserved, future auth
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  isActive: { type: Boolean, default: true }
});

// auto delete when expiresAt is reached
mailboxSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Mailbox = mongoose.model("Mailbox", mailboxSchema);

const messageSchema = new mongoose.Schema({
  mailboxId: { type: mongoose.Schema.Types.ObjectId, ref: "Mailbox", required: true },
  from: { type: String, required: true },
  to: { type: String, required: true },
  subject: { type: String, default: "" },
  text: { type: String, default: "" },
  html: { type: String, default: "" },
  receivedAt: { type: Date, default: Date.now },
  isRead: { type: Boolean, default: false }
});

const Message = mongoose.model("Message", messageSchema);

// ----- EXPRESS + SOCKET.IO SETUP -----
const app = express();
const server = http.createServer(app);

const io = new SocketIOServer(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// middleware
app.use(
  cors({
    origin: "*"
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ----- HELPERS -----
function generateRandomLocalPart(length = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let local = "";
  for (let i = 0; i < length; i++) {
    local += chars[Math.floor(Math.random() * chars.length)];
  }
  return local;
}

function extractEmail(value) {
  if (!value) return "";
  const str = String(value).trim();
  // support "Name <email@domain>"
  const match = str.match(/<(.+?)>/);
  return match ? match[1] : str;
}

// ----- API ROUTES -----

// สร้างกล่องอีเมลใหม่
app.post("/api/mailbox", async (req, res) => {
  try {
    const domain = process.env.MAIL_DOMAIN || "example.com";
    const localPart = generateRandomLocalPart();
    const address = `${localPart}@${domain}`;

    const ttlMinutes = Number(process.env.MAILBOX_TTL_MINUTES || 60);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

    const mailbox = await Mailbox.create({
      address,
      expiresAt
    });

    res.json({
      id: mailbox._id.toString(),
      address: mailbox.address,
      expiresAt: mailbox.expiresAt
    });
  } catch (err) {
    console.error("create mailbox error:", err);
    res.status(500).json({ error: "Failed to create mailbox" });
  }
});

// ดูข้อความทั้งหมดในกล่อง
app.get("/api/mailbox/:id/messages", async (req, res) => {
  try {
    const { id } = req.params;
    const messages = await Message.find({ mailboxId: id })
      .sort({ receivedAt: -1 })
      .lean();

    const formatted = messages.map((m) => ({
      id: m._id.toString(),
      from: m.from,
      to: m.to,
      subject: m.subject,
      text: m.text,
      html: m.html,
      receivedAt: m.receivedAt,
      isRead: m.isRead
    }));

    res.json(formatted);
  } catch (err) {
    console.error("fetch messages error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// ดูอีเมลทีละฉบับ (ถ้าอยากใช้ในอนาคต)
app.get("/api/messages/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const msg = await Message.findById(id).lean();

    if (!msg) {
      return res.status(404).json({ error: "Message not found" });
    }

    res.json({
      id: msg._id.toString(),
      mailboxId: msg.mailboxId,
      from: msg.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      receivedAt: msg.receivedAt,
      isRead: msg.isRead
    });
  } catch (err) {
    console.error("get message error:", err);
    res.status(500).json({ error: "Failed to get message" });
  }
});

// ----- WEBHOOK จาก ThaiBulkSMS -----
app.post("/webhooks/inbound-email", async (req, res) => {
  try {
    console.log("📩 ThaiBulkSMS inbound payload:", req.body);

    const payload = req.body || {};

    const rawTo =
      payload.to_email ||
      payload.to ||
      payload.recipient ||
      payload.toAddress ||
      "";

    const rawFrom =
      payload.from_email ||
      payload.from ||
      payload.sender ||
      payload.fromAddress ||
      "";

    const subject =
      payload.subject ||
      payload.title ||
      payload.mail_subject ||
      "";

    const text =
      payload.text_body ||
      payload.text ||
      payload.body_text ||
      payload.body ||
      "";

    const html =
      payload.html_body ||
      payload.html ||
      payload.body_html ||
      "";

    const toEmail = extractEmail(rawTo);
    const fromEmail = extractEmail(rawFrom);

    if (!toEmail) {
      console.warn("⚠️ No 'to' email found in payload. Payload:", payload);
      return res.status(200).json({ status: "ignored_no_to_email" });
    }

    const mailbox = await Mailbox.findOne({
      address: toEmail,
      isActive: true
    });

    if (!mailbox) {
      console.warn("⚠️ No mailbox found for:", toEmail);
      return res.status(200).json({ status: "ignored_no_mailbox" });
    }

    const message = await Message.create({
      mailboxId: mailbox._id,
      from: fromEmail || "unknown@unknown",
      to: toEmail,
      subject: subject || "",
      text: text || "",
      html: html || ""
    });

    // ส่ง event real-time ไปให้ client ที่ join mailbox นี้
    io.to(`mailbox:${mailbox._id.toString()}`).emit("newMessage", {
      id: message._id.toString(),
      from: message.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      receivedAt: message.receivedAt
    });

    return res.status(200).json({ status: "ok" });
  } catch (err) {
    console.error("❌ inbound webhook error:", err);
    return res.status(500).json({ error: "Webhook error" });
  }
});

// ----- SOCKET.IO -----
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("joinMailbox", (mailboxId) => {
    console.log(`Socket ${socket.id} joined mailbox ${mailboxId}`);
    socket.join(`mailbox:${mailboxId}`);
  });

  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);
  });
});

// ----- SERVE FRONTEND STATIC FILE -----
const publicDir = path.resolve(__dirname, "../public");
app.use(express.static(publicDir));

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// ----- START SERVER -----
const PORT = process.env.PORT || 4000;
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://localhost:27017/temp-mail-demo";

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB connected");
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err);
  });
