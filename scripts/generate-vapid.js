// Generates VAPID keys used to sign push notifications. Run once.
import webpush from 'web-push';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';

const OUT = new URL('../data/vapid.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const dir = OUT.slice(0, OUT.lastIndexOf('/'));
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

if (existsSync(OUT)) {
  console.log('data/vapid.json already exists — keeping existing keys.');
  process.exit(0);
}

const keys = webpush.generateVAPIDKeys();
writeFileSync(
  OUT,
  JSON.stringify(
    { subject: 'mailto:chores@example.com', publicKey: keys.publicKey, privateKey: keys.privateKey },
    null,
    2
  )
);
console.log('Generated data/vapid.json (keep this file private).');
