import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./config/db.js";
import { MongoClient } from "mongodb";
dotenv.config();

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true,
}));

const client = new MongoClient(`mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.owiwght.mongodb.net/`);
app.use(express.json());

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
