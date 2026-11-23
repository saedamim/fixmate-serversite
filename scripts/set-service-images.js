import connectDB, { client, db } from "../config/db.js";
import { serviceImages } from "./lib/service-images.js";

// Gives the seeded services their photos. Only services that have no image yet are changed, by title, so an image a
// technician uploaded is never overwritten. Safe to run more than once.
try {
  await connectDB();

  const result = await db.collection("services").bulkWrite(
    Object.entries(serviceImages).map(([title, imageUrl]) => ({
      updateOne: {
        filter: { title, $or: [{ imageUrl: null }, { imageUrl: "" }, { imageUrl: { $exists: false } }] },
        update: { $set: { imageUrl } },
      },
    }))
  );

  console.log(`Images set on ${result.modifiedCount} of ${Object.keys(serviceImages).length} services (the rest already had one).`);
} finally {
  await client.close();
}
