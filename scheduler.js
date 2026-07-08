// Scheduled reminders: "due today" once each morning, plus overdue nagging.
import cron from 'node-cron';
import { getChores, getUserRaw, _save } from './db.js';
import { notifyUser } from './push.js';

// Local-time 'YYYY-MM-DD' for a Date.
export function ymd(d = new Date()) {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 10);
}

const NAG_INTERVAL_MS = 1000 * 60 * 60 * 20; // re-nag at most every ~20h
const DEFAULT_REMIND_TIME = '08:00'; // used when a chore has no custom reminder time

function nowHM() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// Fire "due today" reminders once each has reached its reminder time.
async function sendDueTodayReminders() {
  const today = ymd();
  const hm = nowHM();
  let changed = false;
  for (const c of getChores()) {
    if (c.status !== 'todo' || !c.assignedTo || !c.dueDate) continue;
    if (c.dueDate !== today || c.notifiedDue === today) continue;
    const remindAt = c.remindTime || DEFAULT_REMIND_TIME;
    if (hm < remindAt) continue; // not time yet
    const user = getUserRaw(c.assignedTo);
    await notifyUser(c.assignedTo, {
      title: '📋 Chore reminder',
      body: `${c.title}${user ? ` — ${user.name}` : ''}`,
      tag: `due-${c.id}`,
      url: '/',
    });
    c.notifiedDue = today;
    changed = true;
  }
  if (changed) _save(); // only touch storage when we actually marked something
}

async function sendOverdueNags() {
  const today = ymd();
  const now = Date.now();
  let changed = false;
  for (const c of getChores()) {
    if (c.status !== 'todo' || !c.assignedTo || !c.dueDate) continue;
    if (c.dueDate < today) {
      if (c.notifiedOverdueAt && now - c.notifiedOverdueAt < NAG_INTERVAL_MS) continue;
      const days = Math.round((new Date(today) - new Date(c.dueDate)) / 86400000);
      await notifyUser(c.assignedTo, {
        title: '⚠️ Overdue chore',
        body: `${c.title} is ${days} day${days === 1 ? '' : 's'} overdue`,
        tag: `overdue-${c.id}`,
        url: '/',
        requireInteraction: true,
      });
      c.notifiedOverdueAt = now;
      changed = true;
    }
  }
  if (changed) _save(); // only touch storage when we actually nagged
}

export function startScheduler() {
  // every minute: send due reminders that have reached their reminder time
  cron.schedule('* * * * *', () => {
    sendDueTodayReminders().catch((e) => console.error('[cron due]', e));
  });

  // every 3 hours during waking hours (9,12,15,18,21): nag on overdue
  cron.schedule('0 9,12,15,18,21 * * *', () => {
    sendOverdueNags().catch((e) => console.error('[cron overdue]', e));
  });

  console.log('[scheduler] per-minute due reminders (custom or 08:00 default) + overdue nags scheduled');
}

// Exposed so an admin can trigger a check immediately (useful for testing).
export async function runChecksNow() {
  await sendDueTodayReminders();
  await sendOverdueNags();
}
