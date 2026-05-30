import db from '../db.js';
import { assertFound, ServiceError } from '../lib/serviceError.js';
import * as estimateLearningService from './estimateLearningService.js';

const TERMINAL_STATUSES = new Set(['done', 'skipped', 'blocked']);

/**
 * @param {import('better-sqlite3').Database} [database]
 * @param {string} visitTaskId
 */
export function getVisitTaskContext(database = db, visitTaskId) {
  return database
    .prepare(
      `SELECT vt.*, v.home_id, v.id AS visit_id, v.status AS visit_status
       FROM visit_tasks vt
       JOIN visits v ON v.id = vt.visit_id
       WHERE vt.id = ?`
    )
    .get(visitTaskId);
}

/**
 * @param {import('better-sqlite3').Database} database
 * @param {string} homeId
 * @param {string} cleanerId
 */
function assertCleanerAccess(database, homeId, cleanerId) {
  const home = database.prepare('SELECT owner_id FROM homes WHERE id = ?').get(homeId);
  assertFound(home, 'Household not found');

  if (home.owner_id === cleanerId) return;

  const member = database
    .prepare(
      `SELECT role FROM home_members WHERE home_id = ? AND user_id = ? AND role = 'cleaner'`
    )
    .get(homeId, cleanerId);
  if (!member) {
    throw new ServiceError('Only the assigned cleaner can update task timing', { status: 403 });
  }
}

/**
 * @param {string} startedAtIso
 * @param {string} [completedAtIso]
 * @returns {number}
 */
export function calculateActualMinutes(startedAtIso, completedAtIso = new Date().toISOString()) {
  const started = new Date(startedAtIso).getTime();
  const completed = new Date(completedAtIso).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed <= started) {
    return 1;
  }
  return Math.max(1, Math.ceil((completed - started) / 60000));
}

/**
 * Cleaner marks START on a visit task.
 * @param {string} visitTaskId
 * @param {string} cleanerId
 * @param {import('better-sqlite3').Database} [database]
 */
export function startTask(visitTaskId, cleanerId, database = db) {
  const vt = getVisitTaskContext(database, visitTaskId);
  assertFound(vt, 'Task not found');
  assertCleanerAccess(database, vt.home_id, cleanerId);

  if (vt.visit_status === 'completed') {
    throw new ServiceError('Visit is already completed');
  }
  if (TERMINAL_STATUSES.has(vt.status)) {
    throw new ServiceError(`Cannot start a task that is already ${vt.status}`);
  }
  if (vt.status === 'in_progress') {
    return database.prepare('SELECT * FROM visit_tasks WHERE id = ?').get(visitTaskId);
  }

  database
    .prepare(
      `UPDATE visit_tasks
       SET status = 'in_progress', started_at = datetime('now'), completed_at = NULL, actual_minutes = NULL
       WHERE id = ?`
    )
    .run(visitTaskId);

  return database.prepare('SELECT * FROM visit_tasks WHERE id = ?').get(visitTaskId);
}

/**
 * Cleaner checks OFF when done; actual duration tracked from started_at.
 * @param {string} visitTaskId
 * @param {string} cleanerId
 * @param {import('better-sqlite3').Database} [database]
 */
export function completeTask(visitTaskId, cleanerId, database = db) {
  const vt = getVisitTaskContext(database, visitTaskId);
  assertFound(vt, 'Task not found');
  assertCleanerAccess(database, vt.home_id, cleanerId);

  if (vt.visit_status === 'completed') {
    throw new ServiceError('Visit is already completed');
  }
  if (vt.status === 'done') {
    return database.prepare('SELECT * FROM visit_tasks WHERE id = ?').get(visitTaskId);
  }
  if (TERMINAL_STATUSES.has(vt.status) && vt.status !== 'done') {
    throw new ServiceError(`Cannot complete a task that is ${vt.status}`);
  }

  const nowIso = new Date().toISOString();
  const actualMinutes = vt.started_at
    ? calculateActualMinutes(vt.started_at, nowIso)
    : null;

  database
    .prepare(
      `UPDATE visit_tasks
       SET status = 'done',
           completed_at = datetime('now'),
           actual_minutes = ?,
           skip_reason = NULL
       WHERE id = ?`
    )
    .run(actualMinutes, visitTaskId);

  if (vt.task_template_id) {
    database
      .prepare(`UPDATE task_templates SET last_completed_at = datetime('now') WHERE id = ?`)
      .run(vt.task_template_id);
  }

  const updated = database.prepare('SELECT * FROM visit_tasks WHERE id = ?').get(visitTaskId);

  if (updated.task_template_id && updated.actual_minutes != null) {
    estimateLearningService.processTaskActual({
      homeId: vt.home_id,
      taskTemplateId: updated.task_template_id,
      visitTaskId: updated.id,
      actualMinutes: updated.actual_minutes,
      database,
    });
  }

  return updated;
}

/**
 * Skip a task (preserves existing skip behavior).
 * @param {string} visitTaskId
 * @param {string} cleanerId
 * @param {string | null | undefined} skipReason
 * @param {import('better-sqlite3').Database} [database]
 */
export function skipTask(visitTaskId, cleanerId, skipReason, database = db) {
  const vt = getVisitTaskContext(database, visitTaskId);
  assertFound(vt, 'Task not found');
  assertCleanerAccess(database, vt.home_id, cleanerId);

  if (vt.visit_status === 'completed') {
    throw new ServiceError('Visit is already completed');
  }
  if (vt.status === 'skipped') {
    return database.prepare('SELECT * FROM visit_tasks WHERE id = ?').get(visitTaskId);
  }

  database
    .prepare(
      `UPDATE visit_tasks
       SET status = 'skipped',
           skip_reason = ?,
           completed_at = datetime('now'),
           started_at = NULL,
           actual_minutes = NULL
       WHERE id = ?`
    )
    .run(skipReason || null, visitTaskId);

  return database.prepare('SELECT * FROM visit_tasks WHERE id = ?').get(visitTaskId);
}

/**
 * Legacy PATCH path: map status transitions without breaking checklist flow.
 * @param {string} visitTaskId
 * @param {{ status: string, skipReason?: string | null, userId: string, userRole?: string }}
 * @param {import('better-sqlite3').Database} [database]
 */
export function updateVisitTaskStatus(
  visitTaskId,
  { status, skipReason, userId, userRole },
  database = db
) {
  const vt = getVisitTaskContext(database, visitTaskId);
  assertFound(vt, 'Task not found');

  const isCleaner =
    userRole === 'cleaner' ||
    database
      .prepare(
        `SELECT 1 FROM home_members WHERE home_id = ? AND user_id = ? AND role = 'cleaner'`
      )
      .get(vt.home_id, userId);

  if (status === 'in_progress') {
    if (!isCleaner) throw new ServiceError('Only the cleaner can start tasks', { status: 403 });
    return startTask(visitTaskId, userId, database);
  }

  if (status === 'done') {
    if (isCleaner && vt.status === 'in_progress') {
      return completeTask(visitTaskId, userId, database);
    }

    database
      .prepare(
        `UPDATE visit_tasks
         SET status = 'done',
             skip_reason = NULL,
             completed_at = datetime('now')
         WHERE id = ?`
      )
      .run(visitTaskId);

    if (vt.task_template_id) {
      database
        .prepare(`UPDATE task_templates SET last_completed_at = datetime('now') WHERE id = ?`)
        .run(vt.task_template_id);
    }

    return database.prepare('SELECT * FROM visit_tasks WHERE id = ?').get(visitTaskId);
  }

  if (status === 'skipped') {
    if (isCleaner) {
      return skipTask(visitTaskId, userId, skipReason, database);
    }

    database
      .prepare(
        `UPDATE visit_tasks
         SET status = 'skipped', skip_reason = ?, completed_at = datetime('now')
         WHERE id = ?`
      )
      .run(skipReason || null, visitTaskId);

    return database.prepare('SELECT * FROM visit_tasks WHERE id = ?').get(visitTaskId);
  }

  if (status === 'pending') {
    database
      .prepare(
        `UPDATE visit_tasks
         SET status = 'pending',
             skip_reason = NULL,
             started_at = NULL,
             completed_at = NULL,
             actual_minutes = NULL
         WHERE id = ?`
      )
      .run(visitTaskId);
    return database.prepare('SELECT * FROM visit_tasks WHERE id = ?').get(visitTaskId);
  }

  if (status === 'blocked') {
    database
      .prepare(
        `UPDATE visit_tasks SET status = 'blocked', skip_reason = ? WHERE id = ?`
      )
      .run(skipReason || null, visitTaskId);
    return database.prepare('SELECT * FROM visit_tasks WHERE id = ?').get(visitTaskId);
  }

  throw new ServiceError('Invalid status');
}
