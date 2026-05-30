import bcrypt from 'bcryptjs';
import cors from 'cors';
import express from 'express';
import jwt from 'jsonwebtoken';
import { networkInterfaces } from 'os';
import { v4 as uuid } from 'uuid';
import db from './db.js';

const app = express();
const PORT = Number(process.env.PORT || 3847);
const JWT_SECRET = process.env.JWT_SECRET || 'bradley-dev-secret-change-in-production';
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

app.use(cors());
app.use(express.json({ limit: '2mb' }));

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function sendExpoPush(tokens, { title, body, data }) {
  const unique = [...new Set(tokens.filter(Boolean))];
  if (!unique.length) return;

  const messages = unique.map((to) => ({
    to,
    sound: 'default',
    title,
    body,
    data: data || {},
    priority: 'high',
    channelId: 'bradley-alerts',
  }));

  try {
    await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });
  } catch (err) {
    console.error('Push failed:', err.message);
  }
}

function cadenceDays(cadence) {
  if (cadence === 'weekly') return 7;
  if (cadence === 'monthly') return 30;
  return 90;
}

function isTaskDue(template, asOf = new Date()) {
  if (!template.active) return false;
  if (!template.last_completed_at) return true;
  const last = new Date(template.last_completed_at);
  const days = cadenceDays(template.cadence);
  const diff = (asOf.getTime() - last.getTime()) / (1000 * 60 * 60 * 24);
  return diff >= days;
}

function getHomeForUser(userId) {
  const owned = db.prepare('SELECT * FROM homes WHERE owner_id = ?').get(userId);
  if (owned) return owned;
  const member = db
    .prepare(
      `SELECT h.* FROM homes h
       JOIN home_members hm ON hm.home_id = h.id
       WHERE hm.user_id = ? AND hm.role IN ('member', 'cleaner')
       LIMIT 1`
    )
    .get(userId);
  return member || null;
}

function getUserHomeRole(userId, homeId) {
  const home = db.prepare('SELECT * FROM homes WHERE id = ?').get(homeId);
  if (!home) return null;
  if (home.owner_id === userId) return 'owner';
  const row = db
    .prepare('SELECT role FROM home_members WHERE home_id = ? AND user_id = ?')
    .get(homeId, userId);
  return row?.role || null;
}

function canManageHome(userId, homeId) {
  const role = getUserHomeRole(userId, homeId);
  return role === 'owner' || role === 'member';
}

function isHouseholdClient(userId, homeId) {
  const role = getUserHomeRole(userId, homeId);
  return role === 'owner' || role === 'member';
}

function userHasHome(userId) {
  return !!getHomeForUser(userId);
}

function getHouseholdManagers(homeId) {
  const home = db.prepare('SELECT * FROM homes WHERE id = ?').get(homeId);
  if (!home) return [];
  const members = db
    .prepare(
      `SELECT u.id, u.display_name, u.email, hm.role
       FROM users u
       JOIN home_members hm ON hm.user_id = u.id
       WHERE hm.home_id = ? AND hm.role IN ('owner', 'member')
       ORDER BY CASE hm.role WHEN 'owner' THEN 0 ELSE 1 END, u.display_name`
    )
    .all(homeId);
  if (!members.some((m) => m.id === home.owner_id)) {
    const owner = db
      .prepare('SELECT id, display_name, email FROM users WHERE id = ?')
      .get(home.owner_id);
    if (owner) members.unshift({ ...owner, role: 'owner' });
  }
  return members;
}

function getHouseholdManagerPushTokens(homeId, excludeUserId) {
  const managers = getHouseholdManagers(homeId);
  return managers
    .filter((m) => m.id !== excludeUserId)
    .map((m) => db.prepare('SELECT push_token FROM users WHERE id = ?').get(m.id)?.push_token)
    .filter(Boolean);
}

function getOwnerId(homeId) {
  const home = db.prepare('SELECT owner_id FROM homes WHERE id = ?').get(homeId);
  return home?.owner_id;
}

function getHomeMembers(homeId) {
  const home = db.prepare('SELECT * FROM homes WHERE id = ?').get(homeId);
  if (!home) return null;
  const cleaners = db
    .prepare(
      `SELECT u.* FROM users u
       JOIN home_members hm ON hm.user_id = u.id
       WHERE hm.home_id = ? AND hm.role = 'cleaner'`
    )
    .all(homeId);
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(home.owner_id);
  return { home, owner, cleaners };
}

function buildVisitTasks(homeId, visitDate) {
  const templates = db
    .prepare(
      `SELECT tt.*, r.name as room_name FROM task_templates tt
       JOIN rooms r ON r.id = tt.room_id
       WHERE r.home_id = ? AND tt.active = 1`
    )
    .all(homeId);

  const asOf = new Date(visitDate);
  return templates.filter((t) => isTaskDue(t, asOf));
}

function ensureVisit(homeId, scheduledDate) {
  let visit = db
    .prepare('SELECT * FROM visits WHERE home_id = ? AND scheduled_date = ?')
    .get(homeId, scheduledDate);

  if (!visit) {
    const id = uuid();
    db.prepare(
      'INSERT INTO visits (id, home_id, scheduled_date, status) VALUES (?, ?, ?, ?)'
    ).run(id, homeId, scheduledDate, 'scheduled');
    visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(id);

    const due = buildVisitTasks(homeId, scheduledDate);
    const insert = db.prepare(
      `INSERT INTO visit_tasks (id, visit_id, task_template_id, room_name, title, instructions, cadence, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
    );
    for (const t of due) {
      insert.run(uuid(), visit.id, t.id, t.room_name, t.title, t.instructions, t.cadence);
    }
  }

  return visit;
}

function syncTemplateToUpcomingVisit(homeId, template, roomName) {
  const home = db.prepare('SELECT * FROM homes WHERE id = ?').get(homeId);
  if (!home) return;

  const date = nextVisitDate(home);
  const visit = db
    .prepare('SELECT * FROM visits WHERE home_id = ? AND scheduled_date = ?')
    .get(homeId, date);
  if (!visit || visit.status === 'completed') return;
  if (!isTaskDue(template, new Date(date))) return;

  const existing = db
    .prepare('SELECT id FROM visit_tasks WHERE visit_id = ? AND task_template_id = ?')
    .get(visit.id, template.id);
  if (existing) return;

  db.prepare(
    `INSERT INTO visit_tasks (id, visit_id, task_template_id, room_name, title, instructions, cadence, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).run(
    uuid(),
    visit.id,
    template.id,
    roomName,
    template.title,
    template.instructions,
    template.cadence
  );
}

function nextVisitDate(home) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const targetDow = home.visit_day;
  const d = new Date(today);
  const current = d.getDay();
  let delta = targetDow - current;
  if (delta < 0) delta += 7;
  if (delta === 0) return d.toISOString().slice(0, 10);
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}

// ─── Auth ───────────────────────────────────────────────────────────────────

app.post('/auth/register', (req, res) => {
  const { email, password, displayName, role } = req.body;
  if (!email || !password || !displayName || !['client', 'cleaner'].includes(role)) {
    return res.status(400).json({ error: 'Invalid registration data' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const id = uuid();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)'
  ).run(id, email.toLowerCase(), hash, displayName, role);

  const token = jwt.sign({ id, email: email.toLowerCase(), role }, JWT_SECRET, { expiresIn: '30d' });
  res.json({
    token,
    user: { id, email: email.toLowerCase(), displayName, role },
  });
});

app.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email?.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
    },
  });
});

app.get('/auth/me', auth, (req, res) => {
  const user = db.prepare('SELECT id, email, display_name, role, push_token FROM users WHERE id = ?').get(
    req.user.id
  );
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    pushToken: user.push_token,
  });
});

app.put('/auth/push-token', auth, (req, res) => {
  const { pushToken } = req.body;
  db.prepare('UPDATE users SET push_token = ? WHERE id = ?').run(pushToken || null, req.user.id);
  res.json({ ok: true });
});

// ─── Homes ──────────────────────────────────────────────────────────────────

app.post('/homes', auth, (req, res) => {
  if (req.user.role !== 'client') {
    return res.status(403).json({ error: 'Only clients can create homes' });
  }
  if (userHasHome(req.user.id)) {
    return res.status(409).json({ error: 'You are already in a household' });
  }

  const { name, visitDay, visitTime } = req.body;
  const id = uuid();
  db.prepare(
    'INSERT INTO homes (id, owner_id, name, visit_day, visit_time) VALUES (?, ?, ?, ?, ?)'
  ).run(id, req.user.id, name || 'My Home', visitDay ?? 2, visitTime || '10:00');

  db.prepare('INSERT INTO home_members (home_id, user_id, role) VALUES (?, ?, ?)').run(
    id,
    req.user.id,
    'owner'
  );

  const defaultRooms = [
    { name: 'Kitchen', tasks: [
      { title: 'Wipe counters', cadence: 'weekly', instructions: 'Use granite-safe cleaner under sink.' },
      { title: 'Clean appliances', cadence: 'monthly', instructions: 'Wipe microwave inside and out.' },
    ]},
    { name: 'Bathrooms', tasks: [
      { title: 'Clean toilets', cadence: 'weekly', instructions: '' },
      { title: 'Scrub shower', cadence: 'monthly', instructions: 'Use non-abrasive scrub.' },
    ]},
    { name: 'Living Areas', tasks: [
      { title: 'Vacuum floors', cadence: 'weekly', instructions: 'Include under couch cushions.' },
      { title: 'Dust surfaces', cadence: 'monthly', instructions: '' },
    ]},
    { name: 'Bedrooms', tasks: [
      { title: 'Change linens', cadence: 'weekly', instructions: 'Fresh sheets in hall closet.' },
      { title: 'Deep clean closets', cadence: 'quarterly', instructions: '' },
    ]},
  ];

  const roomInsert = db.prepare('INSERT INTO rooms (id, home_id, name, sort_order) VALUES (?, ?, ?, ?)');
  const taskInsert = db.prepare(
    'INSERT INTO task_templates (id, room_id, title, instructions, cadence) VALUES (?, ?, ?, ?, ?)'
  );

  defaultRooms.forEach((room, i) => {
    const roomId = uuid();
    roomInsert.run(roomId, id, room.name, i);
    room.tasks.forEach((t) => taskInsert.run(uuid(), roomId, t.title, t.instructions, t.cadence));
  });

  const home = db.prepare('SELECT * FROM homes WHERE id = ?').get(id);
  res.json(home);
});

app.get('/homes/mine', auth, (req, res) => {
  const home = getHomeForUser(req.user.id);
  if (!home) return res.json(null);
  const rooms = db
    .prepare('SELECT * FROM rooms WHERE home_id = ? ORDER BY sort_order')
    .all(home.id);
  const tasks = db
    .prepare(
      `SELECT tt.*, r.name as room_name FROM task_templates tt
       JOIN rooms r ON r.id = tt.room_id
       WHERE r.home_id = ? ORDER BY r.sort_order, tt.title`
    )
    .all(home.id);
  const householdMembers = getHouseholdManagers(home.id);
  const myHomeRole = getUserHomeRole(req.user.id, home.id);
  res.json({ ...home, rooms, tasks, householdMembers, myHomeRole });
});

app.get('/homes/:id/household', auth, (req, res) => {
  const home = db.prepare('SELECT * FROM homes WHERE id = ?').get(req.params.id);
  if (!home || !canManageHome(req.user.id, home.id)) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  res.json({ members: getHouseholdManagers(home.id) });
});

app.patch('/homes/:id', auth, (req, res) => {
  const home = db.prepare('SELECT * FROM homes WHERE id = ?').get(req.params.id);
  if (!home || !canManageHome(req.user.id, home.id)) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const { name, visitDay, visitTime } = req.body;
  db.prepare(
    'UPDATE homes SET name = COALESCE(?, name), visit_day = COALESCE(?, visit_day), visit_time = COALESCE(?, visit_time) WHERE id = ?'
  ).run(name ?? null, visitDay ?? null, visitTime ?? null, home.id);
  res.json(db.prepare('SELECT * FROM homes WHERE id = ?').get(home.id));
});

// ─── Invites ────────────────────────────────────────────────────────────────

app.post('/homes/:id/invite', auth, (req, res) => {
  const home = db.prepare('SELECT * FROM homes WHERE id = ?').get(req.params.id);
  if (!home || !canManageHome(req.user.id, home.id)) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const inviteRole = req.body.inviteRole === 'member' ? 'member' : 'cleaner';
  const code = uuid().slice(0, 8).toUpperCase();
  const expires = new Date();
  expires.setDate(expires.getDate() + 7);
  db.prepare('INSERT INTO invites (code, home_id, role, expires_at) VALUES (?, ?, ?, ?)').run(
    code,
    home.id,
    inviteRole,
    expires.toISOString()
  );
  res.json({ code, expiresAt: expires.toISOString(), inviteRole });
});

app.post('/invites/join', auth, (req, res) => {
  const { code } = req.body;
  const invite = db.prepare('SELECT * FROM invites WHERE code = ?').get(code?.toUpperCase());
  if (!invite) return res.status(404).json({ error: 'Invalid invite code' });
  if (invite.used_by) return res.status(409).json({ error: 'Invite already used' });
  if (new Date(invite.expires_at) < new Date()) {
    return res.status(410).json({ error: 'Invite expired' });
  }

  const memberRole = invite.role === 'member' ? 'member' : 'cleaner';
  if (memberRole === 'member' && req.user.role !== 'client') {
    return res.status(403).json({ error: 'Household invites are for homeowners and renters' });
  }
  if (memberRole === 'cleaner' && req.user.role !== 'cleaner') {
    return res.status(403).json({ error: 'Cleaner invites are for cleaners' });
  }
  if (userHasHome(req.user.id)) {
    return res.status(409).json({ error: 'You are already in a household' });
  }

  db.prepare('INSERT OR IGNORE INTO home_members (home_id, user_id, role) VALUES (?, ?, ?)').run(
    invite.home_id,
    req.user.id,
    memberRole
  );
  db.prepare('UPDATE invites SET used_by = ? WHERE code = ?').run(req.user.id, invite.code);

  const home = db.prepare('SELECT * FROM homes WHERE id = ?').get(invite.home_id);
  res.json({ ...home, myHomeRole: memberRole });
});

// ─── Rooms & Tasks ──────────────────────────────────────────────────────────

app.post('/homes/:homeId/rooms', auth, (req, res) => {
  const home = db.prepare('SELECT * FROM homes WHERE id = ?').get(req.params.homeId);
  if (!home || !canManageHome(req.user.id, home.id)) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const { name } = req.body;
  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM rooms WHERE home_id = ?')
    .get(home.id).m;
  const id = uuid();
  db.prepare('INSERT INTO rooms (id, home_id, name, sort_order) VALUES (?, ?, ?, ?)').run(
    id,
    home.id,
    name,
    maxOrder + 1
  );
  res.json(db.prepare('SELECT * FROM rooms WHERE id = ?').get(id));
});

app.post('/rooms/:roomId/tasks', auth, (req, res) => {
  const room = db
    .prepare(`SELECT r.*, r.home_id FROM rooms r WHERE r.id = ?`)
    .get(req.params.roomId);
  if (!room || !canManageHome(req.user.id, room.home_id)) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const { title, instructions, cadence } = req.body;
  if (!title || !['weekly', 'monthly', 'quarterly'].includes(cadence)) {
    return res.status(400).json({ error: 'Invalid task data' });
  }
  const id = uuid();
  db.prepare(
    'INSERT INTO task_templates (id, room_id, title, instructions, cadence) VALUES (?, ?, ?, ?, ?)'
  ).run(id, room.id, title, instructions || '', cadence);
  const template = db.prepare('SELECT * FROM task_templates WHERE id = ?').get(id);
  syncTemplateToUpcomingVisit(room.home_id, template, room.name);
  res.json(template);
});

app.patch('/tasks/:id', auth, (req, res) => {
  const task = db
    .prepare(
      `SELECT tt.*, r.home_id FROM task_templates tt
       JOIN rooms r ON r.id = tt.room_id
       WHERE tt.id = ?`
    )
    .get(req.params.id);
  if (!task || !canManageHome(req.user.id, task.home_id)) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const { title, instructions, cadence, active } = req.body;
  db.prepare(
    `UPDATE task_templates SET
      title = COALESCE(?, title),
      instructions = COALESCE(?, instructions),
      cadence = COALESCE(?, cadence),
      active = COALESCE(?, active)
     WHERE id = ?`
  ).run(
    title ?? null,
    instructions ?? null,
    cadence ?? null,
    active === undefined ? null : active ? 1 : 0,
    task.id
  );
  res.json(db.prepare('SELECT * FROM task_templates WHERE id = ?').get(task.id));
});

// ─── Visits ─────────────────────────────────────────────────────────────────

app.get('/visits/upcoming', auth, (req, res) => {
  const home = getHomeForUser(req.user.id);
  if (!home) return res.json(null);

  const date = nextVisitDate(home);
  const visit = ensureVisit(home.id, date);
  const tasks = db
    .prepare('SELECT * FROM visit_tasks WHERE visit_id = ? ORDER BY room_name, title')
    .all(visit.id);

  const tasksWithQuestions = tasks.map((t) => {
    const questions = db
      .prepare(
        `SELECT q.*, u.display_name as author_name, u.role as author_role
         FROM task_questions q JOIN users u ON u.id = q.author_id
         WHERE q.visit_task_id = ? ORDER BY q.created_at`
      )
      .all(t.id);
    return { ...t, questions };
  });

  res.json({ visit, tasks: tasksWithQuestions, home });
});

app.get('/visits/history', auth, (req, res) => {
  const home = getHomeForUser(req.user.id);
  if (!home) return res.json([]);
  const visits = db
    .prepare(
      `SELECT * FROM visits WHERE home_id = ? AND status = 'completed'
       ORDER BY scheduled_date DESC LIMIT 20`
    )
    .all(home.id);
  res.json(visits);
});

app.get('/visits/:id', auth, (req, res) => {
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(req.params.id);
  if (!visit) return res.status(404).json({ error: 'Not found' });
  const home = getHomeForUser(req.user.id);
  if (!home || home.id !== visit.home_id) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const tasks = db
    .prepare('SELECT * FROM visit_tasks WHERE visit_id = ? ORDER BY room_name, title')
    .all(visit.id);
  const tasksWithQuestions = tasks.map((t) => {
    const questions = db
      .prepare(
        `SELECT q.*, u.display_name as author_name, u.role as author_role
         FROM task_questions q JOIN users u ON u.id = q.author_id
         WHERE q.visit_task_id = ? ORDER BY q.created_at`
      )
      .all(t.id);
    return { ...t, questions };
  });
  res.json({ visit, tasks: tasksWithQuestions });
});

app.post('/visits/:id/start', auth, (req, res) => {
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(req.params.id);
  if (!visit) return res.status(404).json({ error: 'Not found' });
  if (visit.status !== 'scheduled') {
    return res.json(db.prepare('SELECT * FROM visits WHERE id = ?').get(visit.id));
  }
  db.prepare(
    `UPDATE visits SET status = 'in_progress', started_at = datetime('now') WHERE id = ?`
  ).run(visit.id);

  const ownerId = getOwnerId(visit.home_id);
  const owner = db.prepare('SELECT push_token, display_name FROM users WHERE id = ?').get(ownerId);
  const cleaner = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.user.id);
  void sendExpoPush([owner?.push_token], {
    title: 'Cleaning started',
    body: `${cleaner?.display_name || 'Your cleaner'} started today's visit.`,
    data: { type: 'visit_started', visitId: visit.id },
  });

  res.json(db.prepare('SELECT * FROM visits WHERE id = ?').get(visit.id));
});

app.patch('/visit-tasks/:id', auth, (req, res) => {
  const vt = db
    .prepare(
      `SELECT vt.*, v.home_id, v.id as visit_id, v.status as visit_status
       FROM visit_tasks vt JOIN visits v ON v.id = vt.visit_id
       WHERE vt.id = ?`
    )
    .get(req.params.id);
  if (!vt) return res.status(404).json({ error: 'Not found' });

  const { status, skipReason } = req.body;
  if (!['pending', 'done', 'skipped', 'blocked'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  db.prepare(
    `UPDATE visit_tasks SET status = ?, skip_reason = ?, completed_at = CASE WHEN ? IN ('done','skipped') THEN datetime('now') ELSE NULL END WHERE id = ?`
  ).run(status, skipReason || null, status, vt.id);

  if (status === 'done' && vt.task_template_id) {
    db.prepare('UPDATE task_templates SET last_completed_at = datetime(\'now\') WHERE id = ?').run(
      vt.task_template_id
    );
  }

  res.json(db.prepare('SELECT * FROM visit_tasks WHERE id = ?').get(vt.id));
});

app.post('/visits/:id/complete', auth, (req, res) => {
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(req.params.id);
  if (!visit) return res.status(404).json({ error: 'Not found' });

  db.prepare(
    `UPDATE visits SET status = 'completed', completed_at = datetime('now') WHERE id = ?`
  ).run(visit.id);

  const tasks = db.prepare('SELECT status FROM visit_tasks WHERE visit_id = ?').all(visit.id);
  const done = tasks.filter((t) => t.status === 'done').length;
  const skipped = tasks.filter((t) => t.status === 'skipped').length;
  const pending = tasks.filter((t) => t.status === 'pending').length;

  const ownerId = getOwnerId(visit.home_id);
  const owner = db.prepare('SELECT push_token FROM users WHERE id = ?').get(ownerId);
  void sendExpoPush([owner?.push_token], {
    title: 'Visit complete',
    body: `${done} done, ${skipped} skipped, ${pending} pending.`,
    data: { type: 'visit_completed', visitId: visit.id },
  });

  res.json({
    visit: db.prepare('SELECT * FROM visits WHERE id = ?').get(visit.id),
    summary: { done, skipped, pending, total: tasks.length },
  });
});

// ─── Questions ──────────────────────────────────────────────────────────────

app.post('/visit-tasks/:id/questions', auth, (req, res) => {
  const vt = db
    .prepare(
      `SELECT vt.*, v.home_id FROM visit_tasks vt JOIN visits v ON v.id = vt.visit_id WHERE vt.id = ?`
    )
    .get(req.params.id);
  if (!vt) return res.status(404).json({ error: 'Not found' });

  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message required' });

  const id = uuid();
  db.prepare(
    'INSERT INTO task_questions (id, visit_task_id, author_id, message) VALUES (?, ?, ?, ?)'
  ).run(id, vt.id, req.user.id, message.trim());

  const author = db.prepare('SELECT display_name, role FROM users WHERE id = ?').get(req.user.id);

  if (author.role === 'cleaner') {
    void sendExpoPush(getHouseholdManagerPushTokens(vt.home_id, req.user.id), {
      title: 'Question on a task',
      body: `${author.display_name}: ${message.trim().slice(0, 80)}`,
      data: { type: 'task_question', visitTaskId: vt.id, questionId: id },
    });
  } else {
    const members = db
      .prepare(
        `SELECT u.push_token FROM users u
         JOIN home_members hm ON hm.user_id = u.id
         WHERE hm.home_id = ? AND u.id != ?`
      )
      .all(vt.home_id, req.user.id);
    void sendExpoPush(
      members.map((m) => m.push_token),
      {
        title: 'Owner replied',
        body: `${author.display_name}: ${message.trim().slice(0, 80)}`,
        data: { type: 'task_reply', visitTaskId: vt.id, questionId: id },
      }
    );
  }

  const question = db
    .prepare(
      `SELECT q.*, u.display_name as author_name, u.role as author_role
       FROM task_questions q JOIN users u ON u.id = q.author_id WHERE q.id = ?`
    )
    .get(id);
  res.json(question);
});

app.get('/notifications/unread-count', auth, (req, res) => {
  const home = getHomeForUser(req.user.id);
  if (!home) return res.json({ count: 0 });

  if (req.user.role === 'client') {
    const questions = db
      .prepare(
        `SELECT COUNT(*) as c FROM task_questions q
         JOIN visit_tasks vt ON vt.id = q.visit_task_id
         JOIN visits v ON v.id = vt.visit_id
         JOIN users u ON u.id = q.author_id
         WHERE v.home_id = ? AND u.role = 'cleaner'
         AND q.created_at > datetime('now', '-7 days')`
      )
      .get(home.id).c;
    const invoices = db
      .prepare(
        `SELECT COUNT(*) as c FROM invoices
         WHERE home_id = ? AND status = 'sent'`
      )
      .get(home.id).c;
    return res.json({ count: questions + invoices });
  }

  res.json({ count: 0 });
});

// ─── Payment methods (cleaner receive handles) ──────────────────────────────

app.get('/payment-methods/mine', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM payment_methods WHERE user_id = ?').get(req.user.id);
  res.json(
    row || {
      user_id: req.user.id,
      venmo_handle: null,
      zelle_contact: null,
      cashapp_handle: null,
      paypal_handle: null,
    }
  );
});

app.get('/payment-methods/cleaner/:cleanerId', auth, (req, res) => {
  const home = getHomeForUser(req.user.id);
  if (!home) return res.status(403).json({ error: 'No home' });

  const member = db
    .prepare(
      `SELECT 1 FROM home_members WHERE home_id = ? AND user_id = ? AND role = 'cleaner'`
    )
    .get(home.id, req.params.cleanerId);
  const isOwner = home.owner_id === req.user.id;
  if (!isOwner && !member && req.params.cleanerId !== req.user.id) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  const row = db.prepare('SELECT * FROM payment_methods WHERE user_id = ?').get(req.params.cleanerId);
  const cleaner = db
    .prepare('SELECT id, display_name FROM users WHERE id = ?')
    .get(req.params.cleanerId);
  res.json({
    cleaner,
    methods: row || {
      venmo_handle: null,
      zelle_contact: null,
      cashapp_handle: null,
      paypal_handle: null,
    },
  });
});

app.put('/payment-methods/mine', auth, (req, res) => {
  if (req.user.role !== 'cleaner') {
    return res.status(403).json({ error: 'Only cleaners can set payment methods' });
  }
  const { venmoHandle, zelleContact, cashappHandle, paypalHandle } = req.body;
  const existing = db.prepare('SELECT user_id FROM payment_methods WHERE user_id = ?').get(req.user.id);
  if (existing) {
    db.prepare(
      `UPDATE payment_methods SET
        venmo_handle = ?, zelle_contact = ?, cashapp_handle = ?, paypal_handle = ?,
        updated_at = datetime('now')
       WHERE user_id = ?`
    ).run(
      venmoHandle?.trim() || null,
      zelleContact?.trim() || null,
      cashappHandle?.trim() || null,
      paypalHandle?.trim() || null,
      req.user.id
    );
  } else {
    db.prepare(
      `INSERT INTO payment_methods (user_id, venmo_handle, zelle_contact, cashapp_handle, paypal_handle)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      req.user.id,
      venmoHandle?.trim() || null,
      zelleContact?.trim() || null,
      cashappHandle?.trim() || null,
      paypalHandle?.trim() || null
    );
  }
  res.json(db.prepare('SELECT * FROM payment_methods WHERE user_id = ?').get(req.user.id));
});

// ─── Invoices ───────────────────────────────────────────────────────────────

function invoiceRow(id) {
  return db
    .prepare(
      `SELECT i.*, u.display_name as cleaner_name, v.scheduled_date as visit_date
       FROM invoices i
       JOIN users u ON u.id = i.cleaner_id
       LEFT JOIN visits v ON v.id = i.visit_id
       WHERE i.id = ?`
    )
    .get(id);
}

app.get('/invoices', auth, (req, res) => {
  const home = getHomeForUser(req.user.id);
  if (!home) return res.json([]);

  if (req.user.role === 'client') {
    const rows = db
      .prepare(
        `SELECT i.*, u.display_name as cleaner_name, v.scheduled_date as visit_date
         FROM invoices i
         JOIN users u ON u.id = i.cleaner_id
         LEFT JOIN visits v ON v.id = i.visit_id
         WHERE i.home_id = ?
         ORDER BY i.created_at DESC LIMIT 50`
      )
      .all(home.id);
    return res.json(rows);
  }

  const rows = db
    .prepare(
      `SELECT i.*, u.display_name as cleaner_name, v.scheduled_date as visit_date
       FROM invoices i
       JOIN users u ON u.id = i.cleaner_id
       LEFT JOIN visits v ON v.id = i.visit_id
       WHERE i.cleaner_id = ?
       ORDER BY i.created_at DESC LIMIT 50`
    )
    .all(req.user.id);
  res.json(rows);
});

app.post('/invoices', auth, (req, res) => {
  if (req.user.role !== 'cleaner') {
    return res.status(403).json({ error: 'Only cleaners can send invoices' });
  }
  const home = getHomeForUser(req.user.id);
  if (!home) return res.status(403).json({ error: 'Join a home first' });

  const { amountCents, note, visitId } = req.body;
  if (!amountCents || amountCents < 100) {
    return res.status(400).json({ error: 'Amount must be at least $1.00' });
  }

  if (visitId) {
    const visit = db.prepare('SELECT * FROM visits WHERE id = ? AND home_id = ?').get(visitId, home.id);
    if (!visit) return res.status(404).json({ error: 'Visit not found' });
  }

  const methods = db.prepare('SELECT * FROM payment_methods WHERE user_id = ?').get(req.user.id);
  const hasMethod =
    methods?.venmo_handle || methods?.zelle_contact || methods?.cashapp_handle || methods?.paypal_handle;
  if (!hasMethod) {
    return res.status(400).json({ error: 'Add your Venmo, Zelle, or Cash App info first' });
  }

  const id = uuid();
  db.prepare(
    `INSERT INTO invoices (id, home_id, visit_id, cleaner_id, amount_cents, note, status)
     VALUES (?, ?, ?, ?, ?, ?, 'sent')`
  ).run(id, home.id, visitId || null, req.user.id, amountCents, note?.trim() || '');

  const ownerId = getOwnerId(home.id);
  const owner = db.prepare('SELECT push_token FROM users WHERE id = ?').get(ownerId);
  const amount = (amountCents / 100).toFixed(2);
  const cleaner = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.user.id);
  void sendExpoPush([owner?.push_token], {
    title: 'New invoice',
    body: `${cleaner?.display_name || 'Your cleaner'} sent an invoice for $${amount}`,
    data: { type: 'invoice', invoiceId: id },
  });

  res.json(invoiceRow(id));
});

app.get('/invoices/:id', auth, (req, res) => {
  const invoice = invoiceRow(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Not found' });
  const home = getHomeForUser(req.user.id);
  if (!home || home.id !== invoice.home_id) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const methods = db.prepare('SELECT * FROM payment_methods WHERE user_id = ?').get(invoice.cleaner_id);
  res.json({ invoice, paymentMethods: methods || {} });
});

app.patch('/invoices/:id/paid', auth, (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Not found' });

  const home = getHomeForUser(req.user.id);
  if (!home || home.id !== invoice.home_id || !isHouseholdClient(req.user.id, home.id)) {
    return res.status(403).json({ error: 'Only the homeowner can mark invoices paid' });
  }

  const { paidVia } = req.body;
  if (!paidVia) return res.status(400).json({ error: 'Payment method required' });

  db.prepare(
    `UPDATE invoices SET status = 'paid', paid_via = ?, paid_at = datetime('now') WHERE id = ?`
  ).run(paidVia, invoice.id);

  const cleaner = db.prepare('SELECT push_token FROM users WHERE id = ?').get(invoice.cleaner_id);
  const amount = (invoice.amount_cents / 100).toFixed(2);
  void sendExpoPush([cleaner?.push_token], {
    title: 'Invoice paid',
    body: `Payment of $${amount} received via ${paidVia}`,
    data: { type: 'invoice_paid', invoiceId: invoice.id },
  });

  res.json(invoiceRow(invoice.id));
});

app.patch('/invoices/:id/cancel', auth, (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Not found' });
  if (invoice.cleaner_id !== req.user.id) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  if (invoice.status !== 'sent') {
    return res.status(400).json({ error: 'Invoice cannot be cancelled' });
  }
  db.prepare(`UPDATE invoices SET status = 'cancelled' WHERE id = ?`).run(invoice.id);
  res.json(invoiceRow(invoice.id));
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'bradley-api' });
});

function getLanIp() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

app.listen(PORT, '0.0.0.0', () => {
  const ip = getLanIp();
  console.log(`Bradley API running on http://${ip}:${PORT}`);
  console.log(`Local: http://127.0.0.1:${PORT}`);
});
