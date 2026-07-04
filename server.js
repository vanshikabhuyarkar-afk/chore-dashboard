import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as db from './db.js';
import { getPublicKey, isConfigured, notifyUser, notifyOthers } from './push.js';
import { startScheduler, runChecksNow, ymd } from './scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// --- Config / bootstrap ---
app.get('/api/config', (req, res) => {
  res.json({ vapidPublicKey: getPublicKey(), pushConfigured: isConfigured() });
});

app.get('/api/state', (req, res) => {
  res.json({ users: db.getUsers(), chores: db.getChores(), today: ymd() });
});

// --- Users ---
app.post('/api/users', (req, res) => {
  const { name, color } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  res.json(db.addUser({ name, color: color || '#6366f1' }));
});

app.delete('/api/users/:id', (req, res) => {
  db.removeUser(req.params.id);
  res.json({ ok: true });
});

// --- Push subscriptions ---
app.post('/api/subscribe', (req, res) => {
  const { userId, subscription } = req.body || {};
  if (!userId || !subscription) return res.status(400).json({ error: 'userId and subscription required' });
  const ok = db.saveSubscription(userId, subscription);
  if (!ok) return res.status(404).json({ error: 'unknown user' });
  res.json({ ok: true });
});

app.post('/api/unsubscribe', (req, res) => {
  const { userId, endpoint } = req.body || {};
  db.removeSubscription(userId, endpoint);
  res.json({ ok: true });
});

app.post('/api/test-notification', async (req, res) => {
  const { userId } = req.body || {};
  await notifyUser(userId, {
    title: '🔔 Test notification',
    body: 'Notifications are working! You will get pinged about your chores.',
    tag: 'test',
    url: '/',
  });
  res.json({ ok: true });
});

// --- Chores ---
app.post('/api/chores', async (req, res) => {
  const { title, notes, assignedTo, dueDate, repeat, repeatEvery, rotation, remindTime, actingUserId } =
    req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'title required' });
  const chore = db.addChore({ title, notes, assignedTo, dueDate, repeat, repeatEvery, rotation, remindTime });

  // Notify the assignee (unless they assigned it to themselves)
  if (chore.assignedTo && chore.assignedTo !== actingUserId) {
    await notifyUser(chore.assignedTo, {
      title: '🧹 New chore assigned to you',
      body: chore.dueDate ? `${chore.title} — due ${chore.dueDate}` : chore.title,
      tag: `assigned-${chore.id}`,
      url: '/',
    });
  }
  res.json(chore);
});

app.patch('/api/chores/:id', async (req, res) => {
  const existing = db.getChoreRaw(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const { actingUserId, ...patch } = req.body || {};

  const wasAssignedTo = existing.assignedTo;
  const wasStatus = existing.status;

  // Handle completion (with recurrence) specially.
  if (patch.status === 'done' && wasStatus !== 'done') {
    const actor = actingUserId ? db.getUserRaw(actingUserId) : null;

    // Tell the rest of the household it got done.
    await notifyOthers(
      actingUserId,
      {
        title: '✅ Chore completed',
        body: `${existing.title}${actor ? ` — done by ${actor.name}` : ''}`,
        tag: `done-${existing.id}`,
        url: '/',
      },
      db.getUsers()
    );

    if (existing.repeat && existing.repeat !== 'none') {
      // Roll a recurring chore forward instead of finishing it.
      const next = nextDueDate(existing.dueDate, existing.repeat, existing.repeatEvery);
      const patchNext = {
        status: 'todo',
        dueDate: next,
        completedAt: null,
        completedBy: null,
        notifiedDue: null,
        notifiedOverdueAt: null,
      };
      // If this chore rotates between people, advance to the next person.
      const rotation = existing.rotation || [];
      if (rotation.length > 1) {
        const nextIndex = ((existing.rotationIndex || 0) + 1) % rotation.length;
        patchNext.rotationIndex = nextIndex;
        patchNext.assignedTo = rotation[nextIndex];
      }
      db.updateChore(existing.id, patchNext);
      const rolled = db.getChoreRaw(existing.id);

      // Tell whoever is up next that it's their turn.
      if (rotation.length > 1 && rolled.assignedTo && rolled.assignedTo !== actingUserId) {
        await notifyUser(rolled.assignedTo, {
          title: '🔄 Your turn',
          body: `${rolled.title} — due ${rolled.dueDate}`,
          tag: `turn-${rolled.id}`,
          url: '/',
        });
      }
      return res.json(rolled);
    }

    db.updateChore(existing.id, {
      status: 'done',
      completedAt: Date.now(),
      completedBy: actingUserId || null,
    });
    return res.json(db.getChoreRaw(existing.id));
  }

  // Re-opening a done chore.
  if (patch.status === 'todo' && wasStatus === 'done') {
    patch.completedAt = null;
    patch.completedBy = null;
  }

  const updated = db.updateChore(existing.id, patch);

  // Notify on (re)assignment to someone new.
  if (patch.assignedTo && patch.assignedTo !== wasAssignedTo && patch.assignedTo !== actingUserId) {
    await notifyUser(patch.assignedTo, {
      title: '🧹 Chore assigned to you',
      body: updated.dueDate ? `${updated.title} — due ${updated.dueDate}` : updated.title,
      tag: `assigned-${updated.id}`,
      url: '/',
    });
  }
  res.json(updated);
});

app.delete('/api/chores/:id', (req, res) => {
  db.removeChore(req.params.id);
  res.json({ ok: true });
});

// --- Comments / chat on a chore ---
app.post('/api/chores/:id/comments', async (req, res) => {
  const chore = db.getChoreRaw(req.params.id);
  if (!chore) return res.status(404).json({ error: 'not found' });
  const { userId, text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });

  const comment = db.addComment(chore.id, userId, text);
  const author = userId ? db.getUserRaw(userId) : null;

  // Notify everyone involved (assignee + anyone who already commented), except the author.
  const involved = new Set();
  if (chore.assignedTo) involved.add(chore.assignedTo);
  for (const c of chore.comments) if (c.userId) involved.add(c.userId);
  involved.delete(userId);
  await Promise.all(
    [...involved].map((uid) =>
      notifyUser(uid, {
        title: `💬 ${author ? author.name : 'Someone'} on “${chore.title}”`,
        body: comment.text,
        tag: `comment-${chore.id}`,
        url: '/',
      })
    )
  );
  res.json(comment);
});

// Manually trigger the reminder checks (handy for testing).
app.post('/api/run-checks', async (req, res) => {
  await runChecksNow();
  res.json({ ok: true });
});

function nextDueDate(dueDate, repeat, every = 1) {
  const n = Math.max(1, parseInt(every, 10) || 1);
  const base = dueDate ? new Date(dueDate + 'T00:00:00') : new Date();
  // If the due date is in the past, advance from today so it doesn't stay overdue.
  const today = new Date(ymd() + 'T00:00:00');
  let d = base < today ? today : base;
  if (repeat === 'day') d.setDate(d.getDate() + n);
  else if (repeat === 'week') d.setDate(d.getDate() + 7 * n);
  else if (repeat === 'month') d.setMonth(d.getMonth() + n);
  return ymd(d);
}

// Lightweight health endpoint (also used by the keep-awake pinger).
app.get('/healthz', (req, res) => res.json({ ok: true, at: Date.now() }));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

db.initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n  Chore dashboard running:  http://localhost:${PORT}\n`);
      startScheduler();
    });
  })
  .catch((err) => {
    console.error('Failed to start — database init error:', err.message);
    process.exit(1);
  });
