
import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const client = new MongoClient(process.env.MONGODB_URI);

const db = client.db("fixmate");

const connectDB = async () => {
  try {
    await client.connect();

    await db.command({ ping: 1 });

    console.log("MongoDB connected successfully!");

    return db;
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    process.exit(1);
  }
};

export { client, db };
export default connectDB;

