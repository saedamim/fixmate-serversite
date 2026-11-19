import uploadRoutes from "./routes/upload.routes.js";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { toNodeHandler } from "better-auth/node";
import connectDB from "./config/db.js";
import { auth } from "./config/auth.js";

dotenv.config();

const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    credentials: true,
  })
);

app.all("/api/auth/*splat", toNodeHandler(auth));

app.use(express.json());
app.use("/api/upload", uploadRoutes);
app.get("/", (req, res) => {
  res.send("FixMate API is running!");
});

const PORT = process.env.PORT || 8000;

const startServer = async () => {
  try {
    await connectDB();

    app.listen(PORT, () => {
      console.log(`FixMate server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Server error:", error);
  }
};

startServer();

