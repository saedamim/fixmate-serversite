// Tests for scripts/lib/reset-passwords.js. Uses an in-memory Better Auth instance: no real database, no server.
import test from "node:test";
import assert from "node:assert/strict";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import fs from "node:fs";
import { ObjectId } from "mongodb";
import { TARGETS, selectTargets, checkTargets, checkTargetsWith, mongoReader, resetPasswords } from "../scripts/lib/reset-passwords.js";

const OLD = "old-password-123";
const NEW = { "ahsan@gmail.com": "brand-new-pass-1", "abdurrahim@gmail.com": "brand-new-pass-2", "yeasminmem@gmail.com": "brand-new-pass-3" };

// Fresh in-memory auth with the same additional `role` field as config/auth.js
const makeEnv = async (users) => {
  const auth = betterAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    baseURL: "http://localhost:9999",
    secret: "test-secret-test-secret-test-secret-123",
    emailAndPassword: { enabled: true },
    user: { additionalFields: { role: { type: "string", required: false, defaultValue: "customer", input: false } } },
  });
  const ctx = await auth.$context;
  for (const { email, name, role } of users) {
    await auth.api.signUpEmail({ body: { email, name, password: OLD } });
    const { user } = await ctx.internalAdapter.findUserByEmail(email);
    await ctx.internalAdapter.updateUser(user.id, { role });
  }
  return { auth, ctx };
};

const targetUsers = () => TARGETS.map((t) => ({ email: t.email, name: `Name ${t.email}`, role: t.role }));
const other = { email: "someone@else.com", name: "Someone Else", role: "customer" };

const snapshot = async (ctx, email) => {
  const { user } = await ctx.internalAdapter.findUserByEmail(email);
  const accounts = await ctx.internalAdapter.findAccounts(user.id);
  return { user: structuredClone(user), accounts: structuredClone(accounts) };
};
const canLogin = async (ctx, email, password) => {
  const { user } = await ctx.internalAdapter.findUserByEmail(email);
  const [account] = await ctx.internalAdapter.findAccounts(user.id);
  return ctx.password.verify({ hash: account.password, password });
};

test("resets only the three targets, keeps roles and every other field", async () => {
  const { ctx } = await makeEnv([...targetUsers(), other]);
  const before = {};
  for (const email of [...TARGETS.map((t) => t.email), other.email]) before[email] = await snapshot(ctx, email);

  const done = await resetPasswords(ctx, NEW);
  assert.deepEqual(done.map((d) => d.email).sort(), Object.keys(NEW).sort());

  for (const { email, role } of TARGETS) {
    const after = await snapshot(ctx, email);
    assert.equal(after.user.role, role);
    assert.deepEqual(after.user, before[email].user, `user record of ${email} must be unchanged`);
    const [a0] = before[email].accounts;
    const [a1] = after.accounts;
    const { password: p0, updatedAt: u0, ...rest0 } = a0;
    const { password: p1, updatedAt: u1, ...rest1 } = a1;
    assert.deepEqual(rest1, rest0, "only password (and updatedAt) may change on the account");
    assert.notEqual(p1, p0);
    assert.ok(await canLogin(ctx, email, NEW[email]));
    assert.equal(await canLogin(ctx, email, OLD), false);
  }
  // an unrelated account is completely untouched
  assert.deepEqual(await snapshot(ctx, other.email), before[other.email]);
  assert.ok(await canLogin(ctx, other.email, OLD));
});

test("passwords are stored as Better Auth hashes, never plaintext", async () => {
  const { ctx } = await makeEnv(targetUsers());
  await resetPasswords(ctx, NEW);
  for (const { email } of TARGETS) {
    const { user } = await ctx.internalAdapter.findUserByEmail(email);
    const [account] = await ctx.internalAdapter.findAccounts(user.id);
    assert.notEqual(account.password, NEW[email]);
    assert.ok(!account.password.includes(NEW[email]));
    assert.ok(await ctx.password.verify({ hash: account.password, password: NEW[email] }));
  }
});

test("aborts with no changes when a target account is missing", async () => {
  const { ctx } = await makeEnv(targetUsers().slice(0, 2));
  const before = await snapshot(ctx, "ahsan@gmail.com");
  await assert.rejects(resetPasswords(ctx, NEW), /yeasminmem@gmail.com: no such user/);
  assert.deepEqual(await snapshot(ctx, "ahsan@gmail.com"), before);
  assert.ok(await canLogin(ctx, "ahsan@gmail.com", OLD));
});

test("aborts with no changes when a role is unexpected", async () => {
  const users = targetUsers().map((u) => (u.email === "yeasminmem@gmail.com" ? { ...u, role: "customer" } : u));
  const { ctx } = await makeEnv(users);
  await assert.rejects(resetPasswords(ctx, NEW), /yeasminmem@gmail.com: role is "customer", expected "admin"/);
  for (const { email } of TARGETS) assert.ok(await canLogin(ctx, email, OLD), `${email} must keep the old password`);
});

test("aborts when a target has no email/password credential", async () => {
  const { ctx } = await makeEnv(targetUsers());
  const { user } = await ctx.internalAdapter.findUserByEmail("ahsan@gmail.com");
  await ctx.adapter.deleteMany({ model: "account", where: [{ field: "userId", value: user.id }] });
  await assert.rejects(checkTargets(ctx), /ahsan@gmail.com: expected exactly 1 email\/password credential/);
});

test("refuses any email outside the three targets, extra or missing", async () => {
  const { ctx } = await makeEnv([...targetUsers(), other]);
  await assert.rejects(resetPasswords(ctx, { ...NEW, [other.email]: "another-pass-123" }), /exactly the three target accounts/);
  const { [TARGETS[0].email]: _omit, ...two } = NEW;
  await assert.rejects(resetPasswords(ctx, two), /exactly the three target accounts/);
  assert.ok(await canLogin(ctx, other.email, OLD));
});

test("rejects too-short passwords before changing anything", async () => {
  const { ctx } = await makeEnv(targetUsers());
  await assert.rejects(resetPasswords(ctx, { ...NEW, "ahsan@gmail.com": "short" }), /8-128 characters/);
  for (const { email } of TARGETS) assert.ok(await canLogin(ctx, email, OLD));
});

test("TARGETS is exactly the three approved accounts", () => {
  assert.deepEqual(
    TARGETS.map((t) => `${t.email}:${t.role}`),
    ["ahsan@gmail.com:technician", "abdurrahim@gmail.com:technician", "yeasminmem@gmail.com:admin"]
  );
  assert.ok(Object.isFrozen(TARGETS));
});

// ---- accountId pre-check ----

const breakAccountId = async (ctx, email) => {
  const { user } = await ctx.internalAdapter.findUserByEmail(email);
  await ctx.adapter.updateMany({
    model: "account",
    where: [{ field: "userId", value: user.id }],
    update: { accountId: "not-the-user-id" },
  });
};

test("accountId mismatch on any target aborts everything with zero password changes", async () => {
  for (const broken of TARGETS.map((t) => t.email)) {
    const { ctx } = await makeEnv([...targetUsers(), other]);
    await breakAccountId(ctx, broken);
    const before = {};
    for (const { email } of TARGETS) before[email] = await snapshot(ctx, email);

    await assert.rejects(resetPasswords(ctx, NEW), new RegExp(`${broken}: credential accountId does not equal the user id`));

    for (const { email } of TARGETS) {
      assert.deepEqual(await snapshot(ctx, email), before[email], `${email} must be completely unchanged`);
      assert.ok(await canLogin(ctx, email, OLD), `${email} must keep the old password`);
      assert.equal(await canLogin(ctx, email, NEW[email]), false);
    }
  }
});

// ---- read-only dry run (direct MongoDB reads) ----

// Minimal fake of the mongodb Db that supports ONLY find(query).limit().toArray(). Any write method throws.
const fakeDb = (data) => {
  const same = (a, b) => (a instanceof ObjectId && b instanceof ObjectId ? a.equals(b) : a === b);
  const matches = (doc, query) =>
    Object.entries(query).every(([key, cond]) =>
      cond && typeof cond === "object" && !(cond instanceof ObjectId) && "$in" in cond
        ? cond.$in.some((c) => same(doc[key], c))
        : same(doc[key], cond)
    );
  const calls = [];
  const db = {
    calls,
    collection: (name) =>
      new Proxy(
        {
          find: (query) => {
            calls.push(["find", name]);
            const rows = (data[name] ?? []).filter((doc) => matches(doc, query));
            return { limit: (n) => ({ toArray: async () => rows.slice(0, n) }), toArray: async () => rows };
          },
        },
        { get: (target, prop) => target[prop] ?? (() => { throw new Error(`WRITE/UNSUPPORTED CALL: ${name}.${String(prop)}`); }) }
      ),
  };
  return db;
};

// Documents shaped like Better Auth stores them: _id and account.userId are ObjectIds, accountId is a string
const mongoData = (overrides = {}) => {
  const user = [], account = [];
  for (const t of TARGETS) {
    const _id = new ObjectId();
    user.push({ _id, email: t.email, name: "N", role: overrides.role?.[t.email] ?? t.role });
    account.push({ _id: new ObjectId(), userId: _id, providerId: "credential", accountId: overrides.accountId?.[t.email] ?? _id.toHexString(), password: "hash" });
  }
  return { user, account };
};

test("dry run reads with plain finds, reports exact emails and roles, and never writes", async () => {
  const db = fakeDb(mongoData());
  const before = JSON.stringify(db.collection("user").find({}).toArray && (await db.collection("user").find({}).toArray()));
  const plan = await checkTargetsWith(mongoReader(db));
  assert.deepEqual(plan.map((p) => [p.email, p.role]), TARGETS.map((t) => [t.email, t.role]));
  assert.ok(db.calls.every(([op]) => op === "find"));
  assert.equal(JSON.stringify(await db.collection("user").find({}).toArray()), before);
});

test("dry run aborts on missing user, wrong role, or accountId mismatch", async () => {
  const missing = mongoData();
  missing.user.pop();
  await assert.rejects(checkTargetsWith(mongoReader(fakeDb(missing))), /yeasminmem@gmail.com: no such user/);
  await assert.rejects(
    checkTargetsWith(mongoReader(fakeDb(mongoData({ role: { "ahsan@gmail.com": "customer" } })))),
    /ahsan@gmail.com: role is "customer", expected "technician"/
  );
  await assert.rejects(
    checkTargetsWith(mongoReader(fakeDb(mongoData({ accountId: { "abdurrahim@gmail.com": "x" } })))),
    /abdurrahim@gmail.com: credential accountId does not equal the user id/
  );
});

test("dry run refuses duplicate users with the same email", async () => {
  const data = mongoData();
  data.user.push({ ...data.user[0], _id: new ObjectId() });
  await assert.rejects(checkTargetsWith(mongoReader(fakeDb(data))), /more than one user has this email/);
});

test("the script does not load Better Auth unless --apply is used", () => {
  const source = fs.readFileSync(new URL("../scripts/reset-passwords.js", import.meta.url), "utf8");
  assert.ok(!/^import .*config\/auth\.js/m.test(source), "no static import of config/auth.js");
  const dynamic = source.indexOf(`import("../config/auth.js")`);
  assert.ok(dynamic > source.indexOf("if (!apply)"), "Better Auth is only imported after the dry-run return");
});

// ---- --only (subset) ----

test("--only resets just the chosen accounts and leaves the admin completely untouched", async () => {
  const { ctx } = await makeEnv([...targetUsers(), other]);
  const only = selectTargets("ahsan@gmail.com,abdurrahim@gmail.com");
  const admin = await snapshot(ctx, "yeasminmem@gmail.com");
  const { "yeasminmem@gmail.com": _a, ...two } = NEW;

  const done = await resetPasswords(ctx, two, only);
  assert.deepEqual(done.map((d) => d.email), ["ahsan@gmail.com", "abdurrahim@gmail.com"]);
  assert.ok(await canLogin(ctx, "ahsan@gmail.com", NEW["ahsan@gmail.com"]));
  assert.ok(await canLogin(ctx, "abdurrahim@gmail.com", NEW["abdurrahim@gmail.com"]));
  assert.deepEqual(await snapshot(ctx, "yeasminmem@gmail.com"), admin);
  assert.ok(await canLogin(ctx, "yeasminmem@gmail.com", OLD));
});

test("--only cannot widen the set: unknown or empty lists are rejected, no flag means all three", () => {
  assert.throws(() => selectTargets("someone@else.com"), /--only must list/);
  assert.throws(() => selectTargets("ahsan@gmail.com,someone@else.com"), /not allowed: someone@else.com/);
  assert.throws(() => selectTargets(""), /--only must list/);
  assert.equal(selectTargets(undefined), TARGETS);
  assert.deepEqual(selectTargets(" AHSAN@gmail.com ").map((t) => t.email), ["ahsan@gmail.com"]);
});

test("--only with a password for an account outside the subset is refused", async () => {
  const { ctx } = await makeEnv(targetUsers());
  await assert.rejects(resetPasswords(ctx, NEW, selectTargets("ahsan@gmail.com")), /exactly the three target accounts/);
});
