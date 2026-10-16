import { hashPassword, randomToken, sha256 } from "./security.js";

const nowSeconds = () => Math.floor(Date.now() / 1000);

export async function isSetupComplete(db) {
  return Boolean(await db.prepare("SELECT id FROM admins WHERE id = 1").first());
}

export async function setupAdmin(db, password) {
  const salt = randomToken(16);
  const passwordHash = await hashPassword(password, salt);
  const now = nowSeconds();
  const result = await db.prepare("INSERT OR IGNORE INTO admins (id, password_hash, password_salt, created_at, updated_at) VALUES (1, ?, ?, ?, ?)")
    .bind(passwordHash, salt, now, now).run();
  if (!result.meta?.changes) return false;
  await db.prepare("INSERT INTO audit_log (event, subject, created_at) VALUES ('setup.completed', 'admin', ?)").bind(now).run();
  return true;
}

export async function verifyAdminPassword(db, password) {
  const admin = await db.prepare("SELECT password_hash, password_salt FROM admins WHERE id = 1").first();
  if (!admin) return false;
  const candidate = await hashPassword(password, admin.password_salt);
  // Fixed-size hashes; compare without early exit.
  let diff = 0;
  for (let i = 0; i < candidate.length; i += 1) diff |= candidate.charCodeAt(i) ^ admin.password_hash.charCodeAt(i);
  return diff === 0;
}

export async function createSession(db, ttlSeconds) {
  const token = randomToken(32);
  const now = nowSeconds();
  await db.prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), now, now + ttlSeconds).run();
  return token;
}

export async function getSession(db, token) {
  if (!token || token.length > 128) return null;
  const hash = await sha256(token);
  const session = await db.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").bind(hash).first();
  if (!session || session.expires_at <= nowSeconds()) {
    if (session) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run();
    return null;
  }
  return { tokenHash: hash, expiresAt: session.expires_at };
}

export async function deleteSession(db, token) {
  if (token) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
}

export async function audit(db, event, subject) {
  await db.prepare("INSERT INTO audit_log (event, subject, created_at) VALUES (?, ?, ?)").bind(event, subject, nowSeconds()).run();
}

export async function listAudit(db) {
  const { results } = await db.prepare("SELECT event, subject, created_at FROM audit_log ORDER BY id DESC LIMIT 100").all();
  return results;
}

export async function loginAllowed(db, address, maxAttempts, windowSeconds) {
  const key = `login:${await sha256(address)}`;
  const now = nowSeconds();
  const row = await db.prepare("SELECT value, updated_at FROM settings WHERE key = ?").bind(key).first();
  if (row && row.updated_at + windowSeconds > now && Number(row.value) >= maxAttempts) return false;
  if (!row || row.updated_at + windowSeconds <= now) {
    await db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, '1', ?) ON CONFLICT(key) DO UPDATE SET value='1', updated_at=excluded.updated_at").bind(key, now).run();
  } else {
    await db.prepare("UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = ?").bind(key).run();
  }
  return true;
}

export async function setSetting(db, name, value) {
  await db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .bind(name, value, nowSeconds()).run();
}

export async function getSetting(db, name) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(name).first();
  return row?.value ?? null;
}
