import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import db from './db.js';

const passwordHash = bcrypt.hashSync('demo1234', 10);

const ownerId = uuid();
const cleanerId = uuid();
const homeId = uuid();

db.prepare(
  `INSERT OR IGNORE INTO users (id, email, password_hash, display_name, role)
   VALUES (?, ?, ?, ?, ?)`
).run(ownerId, 'owner@bradly.demo', passwordHash, 'Demo Owner', 'client');

db.prepare(
  `INSERT OR IGNORE INTO users (id, email, password_hash, display_name, role)
   VALUES (?, ?, ?, ?, ?)`
).run(cleanerId, 'cleaner@bradly.demo', passwordHash, 'Demo Cleaner', 'cleaner');

const owner = db.prepare('SELECT id FROM users WHERE email = ?').get('owner@bradly.demo');
const cleaner = db.prepare('SELECT id FROM users WHERE email = ?').get('cleaner@bradly.demo');

if (owner && cleaner) {
  const existingHome = db.prepare('SELECT id FROM homes WHERE owner_id = ?').get(owner.id);
  if (!existingHome) {
    db.prepare(
      `INSERT INTO homes (id, owner_id, name, visit_day, visit_time)
       VALUES (?, ?, ?, ?, ?)`
    ).run(homeId, owner.id, 'Demo Home', 6, '10:00');

    db.prepare(
      `INSERT OR IGNORE INTO home_members (home_id, user_id, role) VALUES (?, ?, 'owner')`
    ).run(homeId, owner.id);

    const kitchenId = uuid();
    const bathId = uuid();
    db.prepare(`INSERT INTO rooms (id, home_id, name, sort_order) VALUES (?, ?, ?, ?)`).run(
      kitchenId,
      homeId,
      'Kitchen',
      0
    );
    db.prepare(`INSERT INTO rooms (id, home_id, name, sort_order) VALUES (?, ?, ?, ?)`).run(
      bathId,
      homeId,
      'Bathroom',
      1
    );

    db.prepare(
      `INSERT INTO task_templates (id, room_id, title, instructions, cadence, active)
       VALUES (?, ?, ?, ?, ?, 1)`
    ).run(uuid(), kitchenId, 'Clean counters', 'Wipe all surfaces', 'weekly');
    db.prepare(
      `INSERT INTO task_templates (id, room_id, title, instructions, cadence, active)
       VALUES (?, ?, ?, ?, ?, 1)`
    ).run(uuid(), bathId, 'Scrub shower', 'Use non-abrasive cleaner', 'monthly');
  }

  db.prepare(
    `INSERT OR REPLACE INTO payment_methods
     (user_id, venmo_handle, zelle_contact, cashapp_handle, paypal_handle)
     VALUES (?, ?, ?, ?, ?)`
  ).run(cleaner.id, '@demo-cleaner', '555-0100', '$democleaner', 'demo-cleaner@paypal.com');

  console.log('Seeded demo accounts:');
  console.log('  owner@bradly.demo / demo1234');
  console.log('  cleaner@bradly.demo / demo1234');
} else {
  console.log('Demo users already exist or could not be created.');
}
