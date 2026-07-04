# 🧹 Chore Dashboard

A self-hosted family chore tracker with assignment and **Android push notifications**.
Installs to the phone home screen as a PWA. One Node process runs everything
(web app + API + notification scheduler). Data is a plain JSON file — no database server.

## Features

- Add family members (name + colour)
- Add chores: title, notes, assignee, due date, and repeat (daily/weekly/monthly)
- Dashboard with To-do / Done / All filters and per-person filters
- Tap the circle to complete; recurring chores automatically roll to the next date
- **Notifications** (Android):
  - 🧹 assigned to you
  - 📋 due today (08:00 each morning)
  - ⚠️ overdue nag (re-pings through the day)
  - ✅ completed (everyone else gets told)

## First-time setup

```sh
npm install
npm run setup      # generates push keys (data/vapid.json) + app icons
npm start          # http://localhost:3000
```

Open it, tap **⚙️ People** to add your family, pick **"I am …"** (top-right),
then tap **🔔** to turn on notifications for that person/phone.
Each person enables 🔔 once on their own phone.

## Putting it on your phones

Notifications require **HTTPS** (browsers only allow push over a secure origin),
and the server must be **running** for scheduled reminders to fire. Two options:

### Option A — Free cloud host (recommended, always-on)
Deploy to **Render**, **Railway**, or **Fly.io** (all have free tiers):
1. Push this folder to a GitHub repo.
2. Create a new Web Service from that repo. Build: `npm install && npm run setup`, Start: `npm start`.
3. Add a **persistent disk** mounted at `/data` (or the repo's `data/` folder) so
   `db.json` and `vapid.json` survive restarts.
4. Open the given `https://…` URL on each Android phone → Chrome menu → **Add to Home screen**.

### Option B — Run at home + a tunnel
Keep it on an always-on home PC and expose it with a tunnel that gives HTTPS:
```sh
npm start
npx cloudflared tunnel --url http://localhost:3000     # prints an https URL
```
Open that HTTPS URL on each phone and **Add to Home screen**. (The PC must stay on
for reminders to fire.)

> On the same Wi-Fi you can browse to `http://<pc-ip>:3000`, but Android push
> needs HTTPS, so use Option A or the tunnel to actually get notifications.

## Notes

- `data/vapid.json` and `data/db.json` are git-ignored (keys are secret; data is yours).
- Reminder times live in `scheduler.js` (cron expressions).
- To trigger the reminder checks immediately for testing: `POST /api/run-checks`.
