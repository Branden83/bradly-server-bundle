import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { assertFound, ServiceError } from '../lib/serviceError.js';
import {
  formatCleaningRequestForCleaner,
  formatCleaningRequestRow,
  serializePreferredDay,
  serializePreferredTime,
} from '../lib/marketplaceFormat.js';
import { sumTaskMinutes } from './estimateService.js';
import {
  optionalPositiveInt,
  requirePositiveInt,
  requireState,
  requireString,
  requireZip,
  validateCadence,
  validateFrequency,
  validateRequestTaskInput,
} from '../validation/marketplace.js';
const OPEN_STATUSES = new Set(['open', 'proposals_received']);

function assertHomeowner(userId) {
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
  assertFound(user, 'User not found');
  if (user.role !== 'client') {
    throw new ServiceError('Only homeowners can manage cleaning requests', { status: 403 });
  }
  return user;
}

function loadRequestTasks(requestId) {
  return db
    .prepare(
      `SELECT * FROM cleaning_request_tasks WHERE request_id = ? ORDER BY sort_order, room_name, task_name`
    )
    .all(requestId);
}

function getRequestRow(requestId) {
  return db.prepare('SELECT * FROM cleaning_requests WHERE id = ?').get(requestId);
}

/**
 * Recalculate and persist estimated_minutes from tasks.
 * @param {string} requestId
 */
export function recalculateEstimatedMinutes(requestId) {
  const tasks = loadRequestTasks(requestId);
  const total = sumTaskMinutes(tasks);
  db.prepare(
    `UPDATE cleaning_requests SET estimated_minutes = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(total, requestId);
  return total;
}

/**
 * @param {string} homeownerId
 * @param {object} body
 */
export function createRequest(homeownerId, body) {
  assertHomeowner(homeownerId);

  const zip = requireZip(body.zip ?? body.zip_code);
  const city = requireString(body.city, 'city', { max: 120 });
  const state = requireState(body.state);
  const bedrooms = requirePositiveInt(body.bedrooms ?? 0, 'bedrooms', { min: 0, max: 20 });
  const bathroomsRaw = Number(body.bathrooms ?? 0);
  if (Number.isNaN(bathroomsRaw) || bathroomsRaw < 0 || bathroomsRaw > 20) {
    throw new ServiceError('Invalid bathrooms');
  }
  const bathrooms = bathroomsRaw;
  const frequency = validateFrequency(body.frequency);
  const squareFeet = optionalPositiveInt(body.homeSizeSqFt ?? body.square_feet, 'home size', {
    min: 100,
    max: 50000,
  });
  const preferences =
    body.preferences != null
      ? String(body.preferences).trim().slice(0, 2000)
      : body.ai_preference_summary != null
        ? String(body.ai_preference_summary).trim().slice(0, 2000)
        : null;
  const preferredDays =
    body.preferred_days ??
    serializePreferredDay(body.preferredDay ?? body.preferred_day) ??
    '[]';
  const preferredTimeWindows =
    body.preferred_time_windows ??
    serializePreferredTime(body.preferredTime ?? body.preferred_time) ??
    '[]';

  const tasksInput = body.tasks;
  if (!Array.isArray(tasksInput) || !tasksInput.length) {
    throw new ServiceError('Add at least one task to your cleaning request');
  }

  const validatedTasks = tasksInput.map((t, i) => validateRequestTaskInput(t, i));
  const estimatedMinutes = sumTaskMinutes(validatedTasks);

  const existingHome = db.prepare('SELECT id FROM homes WHERE owner_id = ?').get(homeownerId);

  const id = uuid();
  const submit = body.submit !== false;

  db.prepare(
    `INSERT INTO cleaning_requests (
      id, homeowner_id, household_id, zip_code, city, state,
      bedrooms, bathrooms, square_feet, frequency,
      preferred_days, preferred_time_windows, ai_preference_summary,
      estimated_minutes, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    homeownerId,
    existingHome?.id ?? null,
    zip,
    city,
    state,
    bedrooms,
    bathrooms,
    squareFeet,
    frequency,
    preferredDays,
    preferredTimeWindows,
    preferences ?? '',
    estimatedMinutes,
    submit ? 'open' : 'draft'
  );

  const insertTask = db.prepare(
    `INSERT INTO cleaning_request_tasks (
      id, request_id, room_name, task_name, notes, cadence,
      estimated_minutes, is_deep_clean, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  validatedTasks.forEach((task, index) => {
    insertTask.run(
      uuid(),
      id,
      task.room_name,
      task.task_name,
      task.notes,
      task.cadence,
      task.estimated_minutes,
      task.is_deep_clean,
      index
    );
  });

  return getRequestForHomeowner(id, homeownerId);
}

/**
 * @param {string} requestId
 * @param {string} homeownerId
 */
export function getRequestForHomeowner(requestId, homeownerId) {
  const row = getRequestRow(requestId);
  assertFound(row, 'Cleaning request not found');
  if (row.homeowner_id !== homeownerId) {
    throw new ServiceError('Not allowed', { status: 403 });
  }
  const tasks = loadRequestTasks(requestId);
  return formatCleaningRequestRow(row, tasks);
}

/**
 * @param {string} homeownerId
 */
export function listRequestsForHomeowner(homeownerId) {
  assertHomeowner(homeownerId);
  const rows = db
    .prepare(
      `SELECT * FROM cleaning_requests WHERE homeowner_id = ? ORDER BY created_at DESC LIMIT 50`
    )
    .all(homeownerId);
  return rows.map((row) => formatCleaningRequestRow(row, loadRequestTasks(row.id)));
}

/**
 * @param {string} requestId
 * @param {string} homeownerId
 * @param {object} body
 */
export function updateRequest(requestId, homeownerId, body) {
  const row = getRequestRow(requestId);
  assertFound(row, 'Cleaning request not found');
  if (row.homeowner_id !== homeownerId) {
    throw new ServiceError('Not allowed', { status: 403 });
  }
  if (!['draft', 'open'].includes(row.status)) {
    throw new ServiceError('This request can no longer be edited');
  }

  const patch = [];
  const values = [];

  if (body.zip != null || body.zip_code != null) {
    patch.push('zip_code = ?');
    values.push(requireZip(body.zip ?? body.zip_code));
  }
  if (body.city != null) {
    patch.push('city = ?');
    values.push(requireString(body.city, 'city', { max: 120 }));
  }
  if (body.state != null) {
    patch.push('state = ?');
    values.push(requireState(body.state));
  }
  if (body.bedrooms != null) {
    patch.push('bedrooms = ?');
    values.push(requirePositiveInt(body.bedrooms, 'bedrooms', { min: 0, max: 20 }));
  }
  if (body.bathrooms != null) {
    patch.push('bathrooms = ?');
    values.push(requirePositiveInt(body.bathrooms, 'bathrooms', { min: 0, max: 20 }));
  }
  if (body.homeSizeSqFt != null || body.square_feet != null) {
    patch.push('square_feet = ?');
    values.push(
      optionalPositiveInt(body.homeSizeSqFt ?? body.square_feet, 'home size', { min: 100, max: 50000 })
    );
  }
  if (body.frequency != null) {
    patch.push('frequency = ?');
    values.push(validateFrequency(body.frequency));
  }
  if (body.preferences != null) {
    patch.push('ai_preference_summary = ?');
    values.push(String(body.preferences).trim().slice(0, 2000));
  }
  if (body.preferredDay != null || body.preferred_day != null) {
    patch.push('preferred_days = ?');
    values.push(serializePreferredDay(body.preferredDay ?? body.preferred_day));
  }
  if (body.preferredTime != null || body.preferred_time != null) {
    patch.push('preferred_time_windows = ?');
    values.push(serializePreferredTime(body.preferredTime ?? body.preferred_time));
  }

  if (patch.length) {
    patch.push("updated_at = datetime('now')");
    db.prepare(`UPDATE cleaning_requests SET ${patch.join(', ')} WHERE id = ?`).run(
      ...values,
      requestId
    );
  }

  if (body.submit) {
    db.prepare(
      `UPDATE cleaning_requests SET status = 'open', updated_at = datetime('now') WHERE id = ? AND status = 'draft'`
    ).run(requestId);
  }

  return getRequestForHomeowner(requestId, homeownerId);
}

/**
 * @param {string} requestId
 * @param {string} homeownerId
 */
export function cancelRequest(requestId, homeownerId) {
  const row = getRequestRow(requestId);
  assertFound(row, 'Cleaning request not found');
  if (row.homeowner_id !== homeownerId) {
    throw new ServiceError('Not allowed', { status: 403 });
  }
  if (['proposal_accepted', 'converted', 'cancelled'].includes(row.status)) {
    throw new ServiceError('This request cannot be cancelled');
  }

  db.prepare(
    `UPDATE cleaning_requests SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`
  ).run(requestId);

  db.prepare(
    `UPDATE cleaner_proposals SET status = 'expired', updated_at = datetime('now')
     WHERE request_id = ? AND status IN ('sent', 'viewed')`
  ).run(requestId);

  return getRequestForHomeowner(requestId, homeownerId);
}

/**
 * @param {string} requestId
 * @param {string} homeownerId
 * @param {object} taskBody
 */
export function addRequestTask(requestId, homeownerId, taskBody) {
  const row = getRequestRow(requestId);
  assertFound(row, 'Cleaning request not found');
  if (row.homeowner_id !== homeownerId) {
    throw new ServiceError('Not allowed', { status: 403 });
  }
  if (!['draft', 'open'].includes(row.status)) {
    throw new ServiceError('Tasks cannot be added to this request');
  }

  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM cleaning_request_tasks WHERE request_id = ?')
    .get(requestId).m;

  const task = validateRequestTaskInput(taskBody, maxOrder + 1);
  const id = uuid();
  db.prepare(
    `INSERT INTO cleaning_request_tasks (
      id, request_id, room_name, task_name, notes, cadence,
      estimated_minutes, is_deep_clean, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    requestId,
    task.room_name,
    task.task_name,
    task.notes,
    task.cadence,
    task.estimated_minutes,
    task.is_deep_clean,
    maxOrder + 1
  );

  recalculateEstimatedMinutes(requestId);
  return db.prepare('SELECT * FROM cleaning_request_tasks WHERE id = ?').get(id);
}

/**
 * @param {string} taskId
 * @param {string} homeownerId
 * @param {object} body
 */
export function updateRequestTask(taskId, homeownerId, body) {
  const task = db
    .prepare(
      `SELECT crt.*, cr.homeowner_id, cr.status as request_status
       FROM cleaning_request_tasks crt
       JOIN cleaning_requests cr ON cr.id = crt.request_id
       WHERE crt.id = ?`
    )
    .get(taskId);
  assertFound(task, 'Task not found');
  if (task.homeowner_id !== homeownerId) {
    throw new ServiceError('Not allowed', { status: 403 });
  }
  if (!['draft', 'open'].includes(task.request_status)) {
    throw new ServiceError('This task cannot be edited');
  }

  const patch = [];
  const values = [];
  if (body.room != null || body.room_name != null) {
    patch.push('room_name = ?');
    values.push(requireString(body.room ?? body.room_name, 'room'));
  }
  if (body.title != null || body.task_name != null) {
    patch.push('task_name = ?');
    values.push(requireString(body.title ?? body.task_name, 'title'));
  }
  if (body.cadence != null) {
    patch.push('cadence = ?');
    values.push(validateCadence(body.cadence));
  }
  if (body.estimated_minutes != null || body.estimatedMinutes != null) {
    patch.push('estimated_minutes = ?');
    values.push(
      requirePositiveInt(body.estimated_minutes ?? body.estimatedMinutes, 'estimated minutes', {
        min: 1,
        max: 480,
      })
    );
  }
  if (body.notes != null) {
    patch.push('notes = ?');
    values.push(String(body.notes).trim().slice(0, 2000));
  }

  if (patch.length) {
    patch.push("updated_at = datetime('now')");
    db.prepare(`UPDATE cleaning_request_tasks SET ${patch.join(', ')} WHERE id = ?`).run(
      ...values,
      taskId
    );
    recalculateEstimatedMinutes(task.request_id);
  }

  return db.prepare('SELECT * FROM cleaning_request_tasks WHERE id = ?').get(taskId);
}

/**
 * @param {string} taskId
 * @param {string} homeownerId
 */
export function removeRequestTask(taskId, homeownerId) {
  const task = db
    .prepare(
      `SELECT crt.*, cr.homeowner_id, cr.status as request_status, cr.id as request_id
       FROM cleaning_request_tasks crt
       JOIN cleaning_requests cr ON cr.id = crt.request_id
       WHERE crt.id = ?`
    )
    .get(taskId);
  assertFound(task, 'Task not found');
  if (task.homeowner_id !== homeownerId) {
    throw new ServiceError('Not allowed', { status: 403 });
  }
  if (!['draft', 'open'].includes(task.request_status)) {
    throw new ServiceError('This task cannot be removed');
  }

  const count = db
    .prepare('SELECT COUNT(*) as c FROM cleaning_request_tasks WHERE request_id = ?')
    .get(task.request_id).c;
  if (count <= 1) {
    throw new ServiceError('A cleaning request must have at least one task');
  }

  db.prepare('DELETE FROM cleaning_request_tasks WHERE id = ?').run(taskId);
  recalculateEstimatedMinutes(task.request_id);
  return { ok: true };
}

/**
 * Open requests in cleaner's service ZIPs (no full address).
 * @param {string} cleanerUserId
 */
export function listAvailableRequestsForCleaner(cleanerUserId) {
  const profile = db.prepare('SELECT * FROM cleaner_profiles WHERE user_id = ?').get(cleanerUserId);
  if (!profile || profile.profile_status !== 'approved' || !profile.accepts_new_clients) {
    return [];
  }

  const zips = db
    .prepare('SELECT zip_code FROM cleaner_service_areas WHERE cleaner_profile_id = ?')
    .all(profile.id)
    .map((z) => String(z.zip_code).slice(0, 5));

  if (!zips.length) return [];

  const placeholders = zips.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM cleaning_requests
       WHERE status IN ('open', 'proposals_received')
       AND substr(zip_code, 1, 5) IN (${placeholders})
       ORDER BY created_at DESC LIMIT 50`
    )
    .all(...zips);

  return rows.map((row) =>
    formatCleaningRequestForCleaner(row, loadRequestTasks(row.id))
  );
}

/**
 * @param {string} requestId
 * @param {string} cleanerUserId
 */
export function getRequestForCleaner(requestId, cleanerUserId) {
  const profile = db.prepare('SELECT * FROM cleaner_profiles WHERE user_id = ?').get(cleanerUserId);
  assertFound(profile, 'Create and get your profile approved to view requests');

  const row = getRequestRow(requestId);
  assertFound(row, 'Cleaning request not found');
  if (!OPEN_STATUSES.has(row.status) && row.status !== 'proposals_received') {
    if (row.status === 'proposal_accepted' || row.status === 'converted') {
      throw new ServiceError('This request has already been accepted', { status: 410 });
    }
    if (row.status === 'cancelled') {
      throw new ServiceError('This request is no longer available', { status: 410 });
    }
  }

  const serves = db
    .prepare(
      `SELECT 1 FROM cleaner_service_areas
       WHERE cleaner_profile_id = ? AND substr(zip_code, 1, 5) = substr(?, 1, 5)`
    )
    .get(profile.id, row.zip_code);
  if (!serves) {
    throw new ServiceError('This request is outside your service area', { status: 403 });
  }

  return formatCleaningRequestForCleaner(row, loadRequestTasks(requestId));
}

/**
 * Mark request as having proposals (called when first proposal sent).
 * @param {string} requestId
 */
export function markProposalsReceived(requestId) {
  db.prepare(
    `UPDATE cleaning_requests SET status = 'proposals_received', updated_at = datetime('now')
     WHERE id = ? AND status = 'open'`
  ).run(requestId);
}

/**
 * @param {string} requestId
 */
export function listRequestsForAdmin() {
  return db
    .prepare(
      `SELECT cr.*, u.display_name as homeowner_name, u.email as homeowner_email
       FROM cleaning_requests cr
       JOIN users u ON u.id = cr.homeowner_id
       ORDER BY cr.created_at DESC LIMIT 200`
    )
    .all();
}

/**
 * @param {string} requestId
 */
export function getRequestForAdmin(requestId) {
  const row = db
    .prepare(
      `SELECT cr.*, u.display_name as homeowner_name, u.email as homeowner_email
       FROM cleaning_requests cr
       JOIN users u ON u.id = cr.homeowner_id
       WHERE cr.id = ?`
    )
    .get(requestId);
  assertFound(row, 'Cleaning request not found');
  const tasks = loadRequestTasks(requestId);
  return { ...formatCleaningRequestRow(row, tasks), homeowner_name: row.homeowner_name, homeowner_email: row.homeowner_email };
}
