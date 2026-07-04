// Web-push wrapper. Loads VAPID keys and sends notifications to a user's devices.
import webpush from 'web-push';
import { readFileSync, existsSync } from 'node:fs';
import { getUserRaw, pruneEndpoint } from './db.js';

const VAPID_PATH = new URL('./data/vapid.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

let vapid = null;
// Prefer environment variables (used in the cloud); fall back to the local file.
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapid = {
    subject: process.env.VAPID_SUBJECT || 'mailto:chores@example.com',
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
  };
} else if (existsSync(VAPID_PATH)) {
  vapid = JSON.parse(readFileSync(VAPID_PATH, 'utf8'));
}

if (vapid) {
  webpush.setVapidDetails(vapid.subject || 'mailto:chores@example.com', vapid.publicKey, vapid.privateKey);
} else {
  console.warn('\n[push] No VAPID keys — set VAPID_* env vars or run `npm run setup` to enable notifications.\n');
}

export function getPublicKey() {
  return vapid?.publicKey ?? null;
}
export function isConfigured() {
  return !!vapid;
}

// Send a notification to every device a user has registered.
export async function notifyUser(userId, payload) {
  if (!vapid) return;
  const user = getUserRaw(userId);
  if (!user || !user.subscriptions?.length) return;

  const body = JSON.stringify(payload);
  await Promise.all(
    user.subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body);
      } catch (err) {
        // 404/410 => subscription is dead, drop it
        if (err.statusCode === 404 || err.statusCode === 410) {
          pruneEndpoint(sub.endpoint);
        } else {
          console.error('[push] send failed:', err.statusCode, err.body || err.message);
        }
      }
    })
  );
}

// Notify everyone except one user (used for "chore completed" broadcasts).
export async function notifyOthers(exceptUserId, payload, users) {
  await Promise.all(
    users.filter((u) => u.id !== exceptUserId).map((u) => notifyUser(u.id, payload))
  );
}
