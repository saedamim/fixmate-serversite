// Assigns technician name + email to the existing services, matched by exact _id.
// Usage:  node scripts/assign-technicians.js           (dry run, writes nothing)
//         node scripts/assign-technicians.js --apply   (performs the updates)
import { ObjectId } from "mongodb";
import connectDB, { client, db } from "../config/db.js";

const APPLY = process.argv.includes("--apply");

const technicians = [
  {
    name: "Abdur Rahim",
    email: "abdurrahim@gmail.com",
    services: [
      ["6b019193934681304329ad40", "AC Deep Cleaning & Servicing"],
      ["6b019193934681304329ad3f", "AC Repair & Gas Refill"],
      ["6b019193934681304329ad42", "Refrigerator Door Seal Replacement"],
      ["6b019193934681304329ad41", "Refrigerator Not Cooling Fix"],
      ["6b019193934681304329ad44", "Washing Machine Drain & Spin Repair"],
      ["6b019193934681304329ad43", "LED / Smart TV Panel Repair"],
    ],
  },
  {
    name: "Karim Ahsan",
    email: "ahsan@gmail.com",
    services: [
      ["6b019193934681304329ad3d", "Laptop Overheating & Fan Repair"],
      ["6b019193934681304329ad3e", "Laptop SSD Upgrade & OS Install"],
      ["6b019193934681304329ad3c", "Phone Water Damage Recovery"],
      ["6b019193934681304329ad3b", "Screen & Battery Replacement"],
      ["6b019193934681304329ad46", "Ceiling Fan & Light Installation"],
      ["6b019193934681304329ad45", "House Wiring & Switchboard Repair"],
    ],
  },
];

const problems = [];

try {
  await connectDB();

  // 1. Both technician accounts must exist with role "technician"
  for (const t of technicians) {
    const user = await db.collection("user").findOne({ email: t.email });
    if (!user) problems.push(`User not found: ${t.email}`);
    else if (user.role !== "technician") problems.push(`${t.email} has role "${user.role}", expected "technician"`);
  }

  // 2. All 12 services must exist, with the expected title for that exact _id
  const plan = [];
  for (const t of technicians) {
    for (const [id, title] of t.services) {
      const service = await db.collection("services").findOne({ _id: new ObjectId(id) });
      if (!service) problems.push(`Service not found: ${id} (${title})`);
      else if (service.title !== title) problems.push(`Service ${id} title is "${service.title}", expected "${title}"`);
      else plan.push({ service, technician: t });
    }
  }

  if (problems.length) {
    console.error("Aborted, nothing was changed. Problems found:");
    problems.forEach((p) => console.error(` - ${p}`));
    process.exitCode = 1;
  } else {
    console.log(`${APPLY ? "APPLYING" : "DRY RUN (no changes)"}: ${plan.length} services\n`);
    for (const { service, technician } of plan) {
      console.log(`${service._id} | ${service.title}`);
      console.log(`   technician:      ${JSON.stringify(service.technician)} -> ${JSON.stringify(technician.name)}`);
      console.log(`   technicianEmail: ${JSON.stringify(service.technicianEmail ?? null)} -> ${JSON.stringify(technician.email)}`);
    }

    if (APPLY) {
      // Only these two fields are set; filter on _id (never on name)
      const result = await db.collection("services").bulkWrite(
        plan.map(({ service, technician }) => ({
          updateOne: {
            filter: { _id: service._id },
            update: { $set: { technician: technician.name, technicianEmail: technician.email } },
          },
        }))
      );
      console.log(`\nDone: ${result.matchedCount} matched, ${result.modifiedCount} modified.`);
    } else {
      console.log("\nDry run only. Re-run with --apply to write these changes.");
    }
  }
} finally {
  await client.close();
}
