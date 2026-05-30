import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { assertFound, ServiceError } from '../lib/serviceError.js';
import { formatCleanerAvailabilityRow } from '../lib/marketplaceFormat.js';
import {
  requireDayOfWeek,
  requireTime,
  validateAvailabilityInput,
} from '../validation/cleanerProfile.js';
import {
  assertCleanerUser,
  assertProfileEditable,
  requireProfileRowByUserId,
} from './cleanerProfileHelpers.js';

function listAvailabilityRows(profileId) {
  return db
    .prepare(
      `SELECT * FROM cleaner_availability
       WHERE cleaner_profile_id = ?
       ORDER BY day_of_week, start_time`
    )
    .all(profileId);
}

/**
 * @param {string} userId
 */
export function listAvailability(userId) {
  const profile = db.prepare('SELECT id FROM cleaner_profiles WHERE user_id = ?').get(userId);
  if (!profile) return [];
  return listAvailabilityRows(profile.id).map(formatCleanerAvailabilityRow);
}

/**
 * @param {string} userId
 * @param {object} body
 */
export function addAvailability(userId, body) {
  assertCleanerUser(userId);
  const profile = requireProfileRowByUserId(userId);
  assertProfileEditable(profile);

  const input = validateAvailabilityInput(body);
  const id = uuid();
  db.prepare(
    `INSERT INTO cleaner_availability (
      id, cleaner_profile_id, day_of_week, start_time, end_time, is_available, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    profile.id,
    input.day_of_week,
    input.start_time,
    input.end_time,
    input.is_available,
    input.notes
  );

  return formatCleanerAvailabilityRow(
    db.prepare('SELECT * FROM cleaner_availability WHERE id = ?').get(id)
  );
}

/**
 * @param {string} userId
 * @param {string} slotId
 * @param {object} body
 */
export function updateAvailability(userId, slotId, body) {
  assertCleanerUser(userId);
  const profile = requireProfileRowByUserId(userId);
  assertProfileEditable(profile);

  const slot = db
    .prepare('SELECT * FROM cleaner_availability WHERE id = ? AND cleaner_profile_id = ?')
    .get(slotId, profile.id);
  assertFound(slot, 'Availability slot not found');

  const patch = [];
  const values = [];

  const nextDay =
    body.dayOfWeek ?? body.day_of_week != null
      ? requireDayOfWeek(body.dayOfWeek ?? body.day_of_week)
      : slot.day_of_week;
  const nextStart =
    body.startTime ?? body.start_time
      ? requireTime(body.startTime ?? body.start_time, 'start time')
      : slot.start_time;
  const nextEnd =
    body.endTime ?? body.end_time
      ? requireTime(body.endTime ?? body.end_time, 'end time')
      : slot.end_time;

  if (nextStart >= nextEnd) {
    throw new ServiceError('End time must be after start time');
  }

  if (body.dayOfWeek != null || body.day_of_week != null) {
    patch.push('day_of_week = ?');
    values.push(nextDay);
  }
  if (body.startTime != null || body.start_time != null) {
    patch.push('start_time = ?');
    values.push(nextStart);
  }
  if (body.endTime != null || body.end_time != null) {
    patch.push('end_time = ?');
    values.push(nextEnd);
  }
  if (body.isAvailable != null || body.is_available != null) {
    patch.push('is_available = ?');
    values.push(body.isAvailable ?? body.is_available ? 1 : 0);
  }
  if (body.notes != null) {
    patch.push('notes = ?');
    values.push(String(body.notes).trim().slice(0, 500));
  }

  if (!patch.length) {
    throw new ServiceError('No fields to update');
  }

  patch.push("updated_at = datetime('now')");
  db.prepare(`UPDATE cleaner_availability SET ${patch.join(', ')} WHERE id = ?`).run(
    ...values,
    slotId
  );

  return formatCleanerAvailabilityRow(
    db.prepare('SELECT * FROM cleaner_availability WHERE id = ?').get(slotId)
  );
}

/**
 * @param {string} userId
 * @param {string} slotId
 */
export function deleteAvailability(userId, slotId) {
  assertCleanerUser(userId);
  const profile = requireProfileRowByUserId(userId);
  assertProfileEditable(profile);

  const slot = db
    .prepare('SELECT id FROM cleaner_availability WHERE id = ? AND cleaner_profile_id = ?')
    .get(slotId, profile.id);
  assertFound(slot, 'Availability slot not found');

  db.prepare('DELETE FROM cleaner_availability WHERE id = ?').run(slotId);
  return { ok: true };
}

export function listAvailabilityForProfileId(profileId) {
  return listAvailabilityRows(profileId);
}
