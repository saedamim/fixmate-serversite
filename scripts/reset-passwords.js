// ONE-TIME, LOCAL-ONLY password reset for three existing accounts (see TARGETS in lib/reset-passwords.js).
//
//   cd fixmate-server
//   node scripts/reset-passwords.js            -> DRY RUN: checks the accounts, asks for nothing, writes nothing
//   node scripts/reset-passwords.js --apply    -> asks for the three new passwords (hidden), then writes them
//
// The dry run uses plain MongoDB find queries only. It never loads Better Auth (whose Mongo adapter can create
// indexes on first use), so it cannot write anything. Better Auth is loaded only for --apply.
//
// Needs an interactive terminal. Passwords are typed hidden, never taken from arguments or env vars,
// never printed, never written to a file. Uses whatever database your local .env points to.
// Delete this script and scripts/lib/reset-passwords.js once the reset is done.
import readline from "node:readline";
import connectDB, { client, db } from "../config/db.js";
import { TARGETS, MIN_LENGTH, MAX_LENGTH, checkTargetsWith, mongoReader, resetPasswords } from "./lib/reset-passwords.js";

// ---- Terminal prompts: ONE readline interface for the whole session, hidden password input, and clean
// cancellation (Ctrl+C, Ctrl+D or a closed input all reject with CancelledError so the database connection is closed).
class CancelledError extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "CancelledError";
  }
}

const createPrompter = ({ input = process.stdin, output = process.stdout } = {}) => {
  const rl = readline.createInterface({ input, output, terminal: true });
  let pending = null; // { reject } of the question being asked
  let hiddenPrompt = null; // while set, only this exact prompt text is echoed, never what is typed
  let closed = false;

  // readline echoes typed characters (and redraws the whole line, e.g. on backspace) through _writeToOutput
  const echo = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (text) => {
    if (hiddenPrompt === null || text === hiddenPrompt) echo(text);
  };

  const cancel = () => {
    closed = true;
    const current = pending;
    pending = null;
    rl.close();
    current?.reject(new CancelledError());
  };
  rl.on("SIGINT", cancel); // Ctrl+C
  rl.on("close", () => {
    if (!closed) cancel(); // Ctrl+D or the input ended
  });

  const ask = (question, { hidden = false } = {}) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(new CancelledError());
      pending = { reject };
      hiddenPrompt = hidden ? question : null;
      rl.question(question, (answer) => {
        pending = null;
        hiddenPrompt = null;
        if (hidden) output.write("\n");
        resolve(answer);
      });
    });

  const close = () => {
    closed = true;
    rl.close();
  };

  return { ask, close };
};

// Asks (hidden) and confirms a password; repeats until it is the right length and typed twice identically
const askPassword = async (prompter, email, { min, max, log = console.log }) => {
  for (;;) {
    const first = await prompter.ask(`New password for ${email}: `, { hidden: true });
    if (first.length < min || first.length > max) {
      log(`  Must be ${min}-${max} characters. Try again.`);
      continue;
    }
    const second = await prompter.ask("  Type it again to confirm: ", { hidden: true });
    if (first !== second) {
      log("  They did not match. Try again.");
      continue;
    }
    return first;
  }
};

const apply = process.argv.slice(2).includes("--apply");
if (process.argv.slice(2).some((arg) => arg !== "--apply")) {
  console.error("Usage: node scripts/reset-passwords.js [--apply]");
  process.exit(1);
}

let prompter;

const run = async () => {
  if (apply && !process.stdin.isTTY) throw new Error("--apply needs an interactive terminal so passwords can be typed hidden.");

  await connectDB();
  // Read-only check with direct MongoDB find queries
  const plan = await checkTargetsWith(mongoReader(db));

  console.log("\nVerified (read-only). All three accounts exist, have the expected role, exactly one email/password login, and a matching accountId:");
  for (const item of plan) console.log(`  ${item.email.padEnd(24)} role: ${item.role}`);

  if (!apply) {
    console.log("\nDRY RUN: nothing was changed. Run again with --apply to set new passwords.");
    return;
  }

  console.log("\nOnly the password of these three accounts will change. Nothing else is touched.");
  prompter = createPrompter();
  if ((await prompter.ask("Type RESET to continue: ")) !== "RESET") {
    console.log("Cancelled. Nothing was changed.");
    return;
  }

  // Only now is Better Auth loaded (apply mode only)
  const { auth } = await import("../config/auth.js");
  const ctx = await auth.$context;

  // All three passwords are collected first; nothing is written until every one is typed and confirmed
  const passwords = {};
  for (const { email } of TARGETS) passwords[email] = await askPassword(prompter, email, { min: MIN_LENGTH, max: MAX_LENGTH });

  const done = await resetPasswords(ctx, passwords);
  console.log("\nDone. Passwords updated and verified for:");
  for (const item of done) console.log(`  ${item.email}  (${item.role})`);
};

run()
  .catch((error) => {
    console.error(error instanceof CancelledError ? "\nCancelled. Nothing was changed." : error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    prompter?.close();
    return client.close();
  });
