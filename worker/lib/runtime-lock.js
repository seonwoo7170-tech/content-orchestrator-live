function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function safeKey(value) {
  const key = String(value || '').trim();
  if (!key || key.length > 80) throw new Error('RUNTIME_LOCK_KEY_INVALID');
  return key;
}

function safeTtlSeconds(value, fallback = 210) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 30 || number > 900) return fallback;
  return number;
}

function isoAfter(now, ttlSeconds) {
  return new Date(now.getTime() + ttlSeconds * 1000).toISOString();
}

function ownerToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function acquireRuntimeLock(env, keyValue, options = {}) {
  const db = requireDb(env);
  const key = safeKey(keyValue);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (Number.isNaN(now.getTime())) throw new Error('RUNTIME_LOCK_TIME_INVALID');
  const ttlSeconds = safeTtlSeconds(options.ttlSeconds, 210);
  const token = ownerToken();
  const expiresAt = isoAfter(now, ttlSeconds);
  const result = await db.prepare(
    `INSERT INTO runtime_locks (lock_key, owner_token, expires_at, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(lock_key) DO UPDATE SET
       owner_token = excluded.owner_token,
       expires_at = excluded.expires_at,
       updated_at = datetime('now')
     WHERE runtime_locks.expires_at <= ?`
  ).bind(key, token, expiresAt, now.toISOString()).run();
  if (Number(result?.meta?.changes || 0) !== 1) {
    return { acquired: false, key, ownerToken: null, expiresAt: null, ttlSeconds };
  }
  return { acquired: true, key, ownerToken: token, expiresAt, ttlSeconds };
}

export async function renewRuntimeLock(env, lease, options = {}) {
  if (!lease?.acquired || !lease?.key || !lease?.ownerToken) return false;
  const db = requireDb(env);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (Number.isNaN(now.getTime())) throw new Error('RUNTIME_LOCK_TIME_INVALID');
  const ttlSeconds = safeTtlSeconds(options.ttlSeconds, lease.ttlSeconds || 210);
  const expiresAt = isoAfter(now, ttlSeconds);
  const result = await db.prepare(
    `UPDATE runtime_locks
        SET expires_at = ?, updated_at = datetime('now')
      WHERE lock_key = ? AND owner_token = ?`
  ).bind(expiresAt, lease.key, lease.ownerToken).run();
  if (Number(result?.meta?.changes || 0) !== 1) return false;
  lease.expiresAt = expiresAt;
  lease.ttlSeconds = ttlSeconds;
  return true;
}

export async function releaseRuntimeLock(env, lease) {
  if (!lease?.acquired || !lease?.key || !lease?.ownerToken) return false;
  const db = requireDb(env);
  const result = await db.prepare(
    'DELETE FROM runtime_locks WHERE lock_key = ? AND owner_token = ?'
  ).bind(lease.key, lease.ownerToken).run();
  return Number(result?.meta?.changes || 0) === 1;
}
