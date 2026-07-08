// Household-sized data store. Keeps the whole dataset as one JSON blob.
// - Locally (no DATABASE_URL): a JSON file, written atomically.
// - In the cloud (DATABASE_URL set): a single JSONB row in Neon/Postgres,
//   so data survives restarts. The blob is loaded into memory on boot and
//   flushed back on every change, keeping all the getters/setters synchronous.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';

const DB_PATH = new URL('./data/db.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const EMPTY = { users: [], chores: [] };
const USE_PG = !!process.env.DATABASE_URL;

let pool = null;
let state = USE_PG ? structuredClone(EMPTY) : loadFile();

// --- boot: called once from server.js before listening ---
export async function initDb() {
  if (!USE_PG) {
    console.log('[db] using local file store (data/db.json)');
    return;
  }
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });
  await pool.query('CREATE TABLE IF NOT EXISTS app_state (id text PRIMARY KEY, data jsonb NOT NULL)');
  const { rows } = await pool.query("SELECT data FROM app_state WHERE id = 'state'");
  if (rows[0]?.data) {
    state = {
      users: rows[0].data.users ?? [],
      chores: rows[0].data.chores ?? [],
      authSecret: rows[0].data.authSecret, // keep the login-signing key stable across restarts
    };
    console.log(`[db] loaded from Postgres: ${state.users.length} users, ${state.chores.length} chores`);
  } else {
    console.log('[db] Postgres connected, no existing state — starting fresh');
  }
}

function loadFile() {
  try {
    if (existsSync(DB_PATH)) {
      const parsed = JSON.parse(readFileSync(DB_PATH, 'utf8'));
      return { users: parsed.users ?? [], chores: parsed.chores ?? [], authSecret: parsed.authSecret };
    }
  } catch (err) {
    console.error('Could not read db.json, starting empty:', err.message);
  }
  return structuredClone(EMPTY);
}

// Async write queue for Postgres: coalesces rapid writes, never overlaps.
let writing = false, dirty = false;
async function flushPg() {
  if (writing) { dirty = true; return; }
  writing = true;
  try {
    do {
      dirty = false;
      await pool.query(
        "INSERT INTO app_state (id, data) VALUES ('state', $1) ON CONFLICT (id) DO UPDATE SET data = $1",
        [JSON.stringify(state)]
      );
    } while (dirty);
  } catch (err) {
    console.error('[db] Postgres write failed:', err.message);
  } finally {
    writing = false;
  }
}

function persist() {
  if (USE_PG) {
    flushPg(); // fire-and-forget; queue guarantees the latest state lands
    return;
  }
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = DB_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, DB_PATH);
}

// --- Users ---
export function getUsers() {
  // never leak push subscriptions or PIN hashes to the client
  return state.users.map(({ subscriptions, pinHash, pinSalt, ...u }) => ({
    ...u,
    devices: (subscriptions ?? []).length,
    hasPin: !!pinHash,
  }));
}
export function getUserRaw(id) {
  return state.users.find((u) => u.id === id);
}
export function addUser({ name, color }) {
  const user = { id: crypto.randomUUID(), name: name.trim(), color, subscriptions: [] };
  state.users.push(user);
  persist();
  const { subscriptions, ...safe } = user;
  return { ...safe, devices: 0 };
}
export function removeUser(id) {
  state.users = state.users.filter((u) => u.id !== id);
  // unassign any chores that pointed at this user
  for (const c of state.chores) if (c.assignedTo === id) c.assignedTo = null;
  persist();
}

export function saveSubscription(userId, subscription) {
  const user = getUserRaw(userId);
  if (!user) return false;
  user.subscriptions ??= [];
  // de-dupe by endpoint
  if (!user.subscriptions.some((s) => s.endpoint === subscription.endpoint)) {
    user.subscriptions.push(subscription);
    persist();
  }
  return true;
}
export function removeSubscription(userId, endpoint) {
  const user = getUserRaw(userId);
  if (!user) return;
  user.subscriptions = (user.subscriptions ?? []).filter((s) => s.endpoint !== endpoint);
  persist();
}
// Remove a dead endpoint from whichever user owns it (used when push returns 410).
export function pruneEndpoint(endpoint) {
  for (const u of state.users) {
    u.subscriptions = (u.subscriptions ?? []).filter((s) => s.endpoint !== endpoint);
  }
  persist();
}

// --- Chores ---
export function getChores() {
  return state.chores;
}
export function getChoreRaw(id) {
  return state.chores.find((c) => c.id === id);
}
export function addChore({ title, notes, assignedTo, dueDate, remindTime, repeat, repeatEvery, rotation }) {
  const rot = Array.isArray(rotation) ? rotation.filter(Boolean) : [];
  const chore = {
    id: crypto.randomUUID(),
    title: title.trim(),
    notes: (notes ?? '').trim(),
    // if rotating, the first person in the rotation starts
    assignedTo: rot.length ? rot[0] : assignedTo || null,
    dueDate: dueDate || null, // 'YYYY-MM-DD'
    remindTime: remindTime || null, // 'HH:MM' local; when to ping on the due date
    repeat: repeat || 'none', // none | day | week | month
    repeatEvery: Math.max(1, parseInt(repeatEvery, 10) || 1), // e.g. every 3 days
    rotation: rot, // ordered list of userIds to alternate through
    rotationIndex: 0,
    comments: [], // { id, userId, text, at }
    status: 'todo',
    createdAt: Date.now(),
    completedAt: null,
    completedBy: null,
    notifiedDue: null, // date string we last sent a "due today" ping for
    notifiedOverdueAt: null, // timestamp of last overdue nag
  };
  state.chores.push(chore);
  persist();
  return chore;
}
export function updateChore(id, patch) {
  const chore = getChoreRaw(id);
  if (!chore) return null;
  Object.assign(chore, patch);
  persist();
  return chore;
}
export function removeChore(id) {
  state.chores = state.chores.filter((c) => c.id !== id);
  persist();
}

export function addComment(choreId, userId, text) {
  const chore = getChoreRaw(choreId);
  if (!chore) return null;
  chore.comments ??= [];
  const comment = { id: crypto.randomUUID(), userId: userId || null, text: String(text).trim(), at: Date.now() };
  chore.comments.push(comment);
  persist();
  return comment;
}

// --- PIN login ---
// PINs are stored only as a salted scrypt hash, never in plain text.
export function userHasPin(id) {
  const u = getUserRaw(id);
  return !!(u && u.pinHash);
}
export function setPin(id, pin) {
  const user = getUserRaw(id);
  if (!user) return false;
  const salt = crypto.randomBytes(16).toString('hex');
  user.pinSalt = salt;
  user.pinHash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  persist();
  return true;
}
export function verifyPin(id, pin) {
  const user = getUserRaw(id);
  if (!user || !user.pinHash) return false;
  const hash = crypto.scryptSync(String(pin), user.pinSalt, 32).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.pinHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function clearPin(id) {
  const user = getUserRaw(id);
  if (!user) return false;
  delete user.pinHash;
  delete user.pinSalt;
  persist();
  return true;
}

// Stateless login tokens: HMAC(userId) with a server secret kept in the DB,
// so tokens stay valid across restarts (no server-side session store needed).
function getAuthSecret() {
  if (!state.authSecret) {
    state.authSecret = crypto.randomBytes(32).toString('hex');
    persist();
  }
  return state.authSecret;
}
export function makeToken(id) {
  const sig = crypto.createHmac('sha256', getAuthSecret()).update(id).digest('hex');
  return `${id}.${sig}`;
}
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const id = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', getAuthSecret()).update(id).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return getUserRaw(id) ? id : null;
}

export function _save() {
  persist();
}
