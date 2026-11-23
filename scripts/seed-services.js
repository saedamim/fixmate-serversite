import connectDB, { client, db } from "../config/db.js";
import { serviceImages } from "./lib/service-images.js";

const base = { imageUrl: null, status: "approved", available: true };

const services = [
  { title: "Screen & Battery Replacement", description: "Cracked screen or weak battery? We replace screens and batteries for most popular smartphone brands using quality parts, and test touch, display and charging before returning the phone.", category: "Smartphone", mode: "In-shop", price: 25, technician: "Rafiq Ahmed", featured: true, createdAt: "2026-11-18" },
  { title: "Phone Water Damage Recovery", description: "Ultrasonic cleaning and component-level repair for phones that stopped working after contact with water. Data recovery is attempted before any part is replaced.", category: "Smartphone", mode: "Pickup & Drop", price: 30, technician: "Rafiq Ahmed", featured: false, createdAt: "2026-10-28" },
  { title: "Laptop Overheating & Fan Repair", description: "Fixes laptops that run hot, shut down or have a noisy fan. Includes cleaning dust, replacing thermal paste and swapping a faulty fan, with a full temperature check afterwards.", category: "Laptop & PC", mode: "Pickup & Drop", price: 30, technician: "Nusrat Jahan", featured: true, createdAt: "2026-11-16" },
  { title: "Laptop SSD Upgrade & OS Install", description: "Replace a slow hard drive with an SSD, clone your existing data and install a fresh operating system with drivers. Typically cuts boot time to under 15 seconds.", category: "Laptop & PC", mode: "In-shop", price: 40, technician: "Nusrat Jahan", featured: false, createdAt: "2026-10-22" },
  { title: "AC Repair & Gas Refill", description: "Diagnosis and repair for air conditioners that are not cooling, leaking water or making noise. Includes gas leak checking, gas refill and a cooling performance test.", category: "AC", mode: "On-site", price: 45, technician: "Karim Hossain", featured: true, createdAt: "2026-11-15" },
  { title: "AC Deep Cleaning & Servicing", description: "Full indoor and outdoor unit cleaning, filter wash, drain line clearing and coil check to restore cooling and reduce electricity use.", category: "AC", mode: "On-site", price: 25, technician: "Karim Hossain", featured: false, createdAt: "2026-10-15" },
  { title: "Refrigerator Not Cooling Fix", description: "Repair for refrigerators that are not cooling, freezing too much or running loudly. Covers thermostat, compressor relay, door seal and fan checks.", category: "Refrigerator", mode: "On-site", price: 40, technician: "Sadia Islam", featured: true, createdAt: "2026-11-12" },
  { title: "Refrigerator Door Seal Replacement", description: "Replace worn or torn door gaskets to stop cold air leaking, remove ice build-up and lower power consumption. Suitable for single and double door models.", category: "Refrigerator", mode: "On-site", price: 22, technician: "Sadia Islam", featured: false, createdAt: "2026-10-05" },
  { title: "LED / Smart TV Panel Repair", description: "Repair for LED and smart TVs with display lines, dark screens, backlight faults or sound problems. The panel and power board are inspected before any repair starts.", category: "TV", mode: "In-shop", price: 55, technician: "Tanvir Alam", featured: true, createdAt: "2026-11-10" },
  { title: "Washing Machine Drain & Spin Repair", description: "Fixes washing machines that do not drain, spin or start. Covers drain pump, belt, door lock and inlet valve problems for front and top loaders.", category: "Washing Machine", mode: "On-site", price: 35, technician: "Mizanur Rahman", featured: true, createdAt: "2026-11-08" },
  { title: "House Wiring & Switchboard Repair", description: "Safe repair of switchboards, sockets, wiring faults and tripping breakers by an experienced electrician. All work is tested before the visit ends.", category: "Electrical", mode: "On-site", price: 20, technician: "Habib Khan", featured: true, createdAt: "2026-11-05" },
  { title: "Ceiling Fan & Light Installation", description: "Installation or replacement of ceiling fans, regulators and light fittings, including safe wiring and a final test run.", category: "Electrical", mode: "On-site", price: 15, technician: "Habib Khan", featured: false, createdAt: "2026-09-30" },
];

try {
  await connectDB();

  // Upsert by title: `$setOnInsert` only applies to new docs, so re-running
  // never duplicates and never overwrites edits made later. _id is an
  // auto-generated ObjectId.
  const result = await db.collection("services").bulkWrite(
    services.map((service) => ({
      updateOne: {
        filter: { title: service.title },
        update: { $setOnInsert: { ...base, ...service, imageUrl: serviceImages[service.title] ?? null } },
        upsert: true,
      },
    }))
  );

  console.log(`Seed done: ${result.upsertedCount} inserted, ${services.length - result.upsertedCount} already existed.`);
} finally {
  await client.close();
}
