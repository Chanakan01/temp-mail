import express from "express";
import http from "http";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import { Server as SocketIOServer } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

import mailboxRoutes from "./routes/mailbox.js";
import messageRoutes from "./routes/messages.js";
import inboundWebhook from "./webhooks/inbound.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

const io = new SocketIOServer(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.set("io", io);

// Middleware
app.use(
  cors({
    origin: "*"
  })
);
app.use(express.json({ limit: "10mb" }));

// API routes
app.use("/api/mailbox", mailboxRoutes);
app.use("/api/messages", messageRoutes);
app.post("/webhooks/inbound-email", inboundWebhook);

// Serve React build (client/dist)
const clientDistPath = path.resolve(__dirname, "../../client/dist");
app.use(express.static(clientDistPath));

app.get("*", (req, res) => {
  res.sendFile(path.join(clientDistPath, "index.html"));
});

// Socket.io handling
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

// Connect DB and start server
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
