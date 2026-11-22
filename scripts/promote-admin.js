// DRY RUN ONLY: shows what promoting a user to "admin" would change. It never writes to the database.
//
// Usage:  node scripts/promote-admin.js <email>
// Example: node scripts/promote-admin.js new-admin@example.com
//
// IMPORTANT: run it from the fixmate-server folder (the one that contains .env):
//   cd fixmate-server
//   node scripts/promote-admin.js <email>
// Run from any other folder, the database settings are not found and the script crashes before it starts.
//
// Safe order of steps:
//   1. Sign up a NEW account on the Sign Up page (it starts as a "customer").
//   2. Run this script with that email and read the report.
//   3. Only the person who owns the database should make the actual change.
import connectDB, { client, db } from "../config/db.js";

const usage = () => {
  console.error("Usage: node scripts/promote-admin.js <email>   (run from the fixmate-server folder)");
  console.error("This is a dry run: it only reports what would change and never writes to the database.");
  process.exit(1);
};

// Exactly one argument is allowed: the email
const args = process.argv.slice(2);
if (args.length !== 1) usage();

// Better Auth stores emails in lowercase
const email = args[0].trim().toLowerCase();

// Basic shape check only: something@something.something with no spaces
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error(`"${args[0]}" is not a valid email address.`);
  usage();
}

const run = async () => {
  await connectDB();

  // Read-only lookup of the exact email (no partial or case-insensitive search)
  const matches = await db.collection("user").find({ email }).project({ name: 1, email: 1, role: 1 }).toArray();

  console.log("\nDRY RUN: nothing will be written to the database.\n");
  console.log(`Looking for user: ${email}`);

  if (matches.length === 0) {
    console.log("\nResult: NO USER FOUND with this exact email.");
    console.log("Sign up first on the Sign Up page, then run this script again. Nothing was changed.");
    return;
  }

  if (matches.length > 1) {
    console.log(`\nResult: ${matches.length} users share this email. Refusing to propose a change. Nothing was changed.`);
    return;
  }

  const user = matches[0];
  const currentRole = user.role ?? "(none)";

  console.log("\nFound exactly one user:");
  console.log(`  id:           ${user._id}`);
  console.log(`  name:         ${user.name}`);
  console.log(`  email:        ${user.email}`);
  console.log(`  current role: ${currentRole}`);

  if (user.role === "admin") {
    console.log("\nResult: this user is already an admin. No change is needed.");
  } else if (user.role !== "customer") {
    console.log(`\nResult: NOT RECOMMENDED. This account is a "${currentRole}", so it is probably an existing`);
    console.log("account in use. Use a brand-new account that was just signed up (a customer) instead.");
  } else {
    console.log("\nProposed change (NOT applied):");
    console.log(`  role: "${currentRole}" -> "admin"`);
    console.log("\nThis looks like a plain customer account, so it is a suitable candidate.");
    console.log("Make sure this is the NEW account you just signed up and not an account you already use.");
  }

  console.log("\nThis script has no apply option. No data was modified.");
};

run()
  .catch((error) => {
    console.error("Dry run failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => client.close());
