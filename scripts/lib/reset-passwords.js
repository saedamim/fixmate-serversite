// Core logic of the one-time password reset. Writes go only through Better Auth's own context
// (`await auth.$context`), so they use the same password hashing and credential-account update that Better Auth
// itself uses. The read-only dry run uses plain MongoDB find queries instead (see mongoReader).
//
// IMPORTANT: ctx.internalAdapter.updatePassword is an INTERNAL Better Auth API, not a public or stable one. It is
// not covered by compatibility guarantees and may change in any release. This tool was checked against
// better-auth 1.7.25 only; re-check the source before reusing it with another version. Because it is a one-time
// tool, delete it after use.
//
// Nothing here prints, logs or returns a password or a hash.

// The ONLY accounts this tool can ever touch, with the role each one must currently have.
export const TARGETS = Object.freeze([
  Object.freeze({ email: "ahsan@gmail.com", role: "technician" }),
  Object.freeze({ email: "abdurrahim@gmail.com", role: "technician" }),
  Object.freeze({ email: "yeasminmem@gmail.com", role: "admin" }),
]);

export const MIN_LENGTH = 8;
export const MAX_LENGTH = 128;

// A "reader" is { findUser(email) -> { id, role } | null, findAccounts(user) -> [{ providerId, accountId }] }.
// Both readers below only READ. The raw Mongo one is used for the dry run, so no Better Auth adapter code runs
// (that adapter can create indexes on first use).

// Reader on top of Better Auth's context (used when applying)
export const ctxReader = (ctx) => ({
  findUser: async (email) => (await ctx.internalAdapter.findUserByEmail(email))?.user ?? null,
  findAccounts: (user) => ctx.internalAdapter.findAccounts(user.id),
});

// Reader straight on MongoDB with plain find queries (used for the dry run). Better Auth's Mongo adapter stores the
// user id as an ObjectId in user._id and account.userId, and account.accountId as a plain string.
export const mongoReader = (db) => ({
  findUser: async (email) => {
    const users = await db.collection("user").find({ email }).limit(2).toArray();
    if (users.length > 1) throw new Error(`${email}: more than one user has this email, refusing to continue`);
    return users[0] ? { id: String(users[0]._id), role: users[0].role, oid: users[0]._id } : null;
  },
  findAccounts: async (user) => {
    const accounts = await db
      .collection("account")
      .find({ userId: { $in: [user.oid, user.id] } })
      .toArray();
    return accounts.map((account) => ({ providerId: account.providerId, accountId: String(account.accountId) }));
  },
});

// Read-only. Verifies every target exists exactly as expected. Returns a plan, or throws without changing anything.
export const checkTargetsWith = async (reader, targets = TARGETS) => {
  const problems = [];
  const plan = [];

  for (const target of targets) {
    const user = await reader.findUser(target.email);
    if (!user) {
      problems.push(`${target.email}: no such user (this tool never creates users)`);
      continue;
    }
    if (user.role !== target.role) {
      problems.push(`${target.email}: role is "${user.role ?? "(none)"}", expected "${target.role}"`);
      continue;
    }
    const accounts = await reader.findAccounts(user);
    const credentials = accounts.filter((account) => account.providerId === "credential");
    if (credentials.length !== 1) {
      problems.push(`${target.email}: expected exactly 1 email/password credential account, found ${credentials.length}`);
      continue;
    }
    // updatePassword (internal API) only matches a credential account whose accountId equals the user id.
    // If it does not, the update would silently skip this account, so refuse before anything is written.
    if (String(credentials[0].accountId) !== String(user.id)) {
      problems.push(`${target.email}: credential accountId does not equal the user id, the password update would not apply`);
      continue;
    }
    plan.push({ email: target.email, role: target.role, userId: user.id });
  }

  if (problems.length > 0) {
    throw new Error(`Aborted, nothing was changed:\n  - ${problems.join("\n  - ")}`);
  }
  return plan;
};

export const checkTargets = (ctx, targets = TARGETS) => checkTargetsWith(ctxReader(ctx), targets);

// `passwords` is { [email]: plaintext }. It must contain exactly the target emails, nothing more or less.
export const resetPasswords = async (ctx, passwords, targets = TARGETS) => {
  const wanted = targets.map((target) => target.email).sort();
  const given = Object.keys(passwords).sort();
  if (wanted.length !== given.length || wanted.some((email, i) => email !== given[i])) {
    throw new Error("Passwords must be supplied for exactly the three target accounts and no others.");
  }
  for (const email of wanted) {
    const password = passwords[email];
    if (typeof password !== "string" || password.length < MIN_LENGTH || password.length > MAX_LENGTH) {
      throw new Error(`The password for ${email} must be ${MIN_LENGTH}-${MAX_LENGTH} characters.`);
    }
  }

  // All checks happen before the first write, so a bad account means zero changes.
  const plan = await checkTargets(ctx, targets);

  // Hash everything first too: if hashing throws, nothing has been written yet.
  const hashes = [];
  for (const item of plan) hashes.push(await ctx.password.hash(passwords[item.email]));

  for (const [i, item] of plan.entries()) {
    await ctx.internalAdapter.updatePassword(item.userId, hashes[i]);
  }

  // Confirm each new password verifies against what was stored (still without printing anything).
  for (const item of plan) {
    const accounts = await ctx.internalAdapter.findAccounts(item.userId);
    const credential = accounts.find((account) => account.providerId === "credential");
    const ok = await ctx.password.verify({ hash: credential.password, password: passwords[item.email] });
    if (!ok) throw new Error(`Verification failed for ${item.email}. Check this account before doing anything else.`);
  }

  return plan.map(({ email, role }) => ({ email, role }));
};
