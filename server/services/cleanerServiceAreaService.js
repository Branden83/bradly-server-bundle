import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { assertFound, ServiceError } from '../lib/serviceError.js';
import { formatCleanerServiceAreaRow } from '../lib/marketplaceFormat.js';
import { validateServiceAreaInput } from '../validation/cleanerProfile.js';
import {
  assertCleanerUser,
  assertProfileEditable,
  requireProfileRowByUserId,
} from './cleanerProfileHelpers.js';

function listAreaRows(profileId) {
  return db
    .prepare(
      'SELECT * FROM cleaner_service_areas WHERE cleaner_profile_id = ? ORDER BY is_primary DESC, zip_code'
    )
    .all(profileId);
}

/**
 * @param {string} userId
 */
export function listServiceAreas(userId) {
  const profile = db.prepare('SELECT id FROM cleaner_profiles WHERE user_id = ?').get(userId);
  if (!profile) return [];
  return listAreaRows(profile.id).map(formatCleanerServiceAreaRow);
}

/**
 * @param {string} userId
 * @param {object} body
 */
export function addServiceArea(userId, body) {
  assertCleanerUser(userId);
  const profile = requireProfileRowByUserId(userId);
  assertProfileEditable(profile);

  const input = validateServiceAreaInput(body);
  const dup = db
    .prepare(
      'SELECT id FROM cleaner_service_areas WHERE cleaner_profile_id = ? AND zip_code = ?'
    )
    .get(profile.id, input.zip_code);
  if (dup) {
    throw new ServiceError('This ZIP is already in your service area', { status: 409 });
  }

  if (input.is_primary) {
    db.prepare(
      `UPDATE cleaner_service_areas SET is_primary = 0, updated_at = datetime('now')
       WHERE cleaner_profile_id = ?`
    ).run(profile.id);
  }

  const id = uuid();
  db.prepare(
    `INSERT INTO cleaner_service_areas (
      id, cleaner_profile_id, zip_code, city, state, radius_miles, is_primary
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    profile.id,
    input.zip_code,
    input.city,
    input.state,
    input.radius_miles,
    input.is_primary
  );

  return formatCleanerServiceAreaRow(
    db.prepare('SELECT * FROM cleaner_service_areas WHERE id = ?').get(id)
  );
}

/**
 * @param {string} userId
 * @param {string} areaId
 * @param {object} body
 */
export function updateServiceArea(userId, areaId, body) {
  assertCleanerUser(userId);
  const profile = requireProfileRowByUserId(userId);
  assertProfileEditable(profile);

  const area = db
    .prepare('SELECT * FROM cleaner_service_areas WHERE id = ? AND cleaner_profile_id = ?')
    .get(areaId, profile.id);
  assertFound(area, 'Service area not found');

  const patch = [];
  const values = [];

  if (body.zipCode != null || body.zip_code != null) {
    const nextZip = validateServiceAreaInput({ ...area, ...body }).zip_code;
    const dup = db
      .prepare(
        'SELECT id FROM cleaner_service_areas WHERE cleaner_profile_id = ? AND zip_code = ? AND id != ?'
      )
      .get(profile.id, nextZip, areaId);
    if (dup) {
      throw new ServiceError('This ZIP is already in your service area', { status: 409 });
    }
    patch.push('zip_code = ?');
    values.push(nextZip);
  }
  if (body.city != null) {
    patch.push('city = ?');
    values.push(validateServiceAreaInput({ ...area, city: body.city }).city);
  }
  if (body.state != null) {
    patch.push('state = ?');
    values.push(validateServiceAreaInput({ ...area, state: body.state }).state);
  }
  if (body.radiusMiles != null || body.radius_miles != null) {
    patch.push('radius_miles = ?');
    values.push(
      validateServiceAreaInput({
        ...area,
        radius_miles: body.radiusMiles ?? body.radius_miles,
      }).radius_miles
    );
  }
  if (body.isPrimary != null || body.is_primary != null) {
    const isPrimary = body.isPrimary ?? body.is_primary ? 1 : 0;
    if (isPrimary) {
      db.prepare(
        `UPDATE cleaner_service_areas SET is_primary = 0, updated_at = datetime('now')
         WHERE cleaner_profile_id = ?`
      ).run(profile.id);
    }
    patch.push('is_primary = ?');
    values.push(isPrimary);
  }

  if (!patch.length) {
    throw new ServiceError('No fields to update');
  }

  patch.push("updated_at = datetime('now')");
  db.prepare(`UPDATE cleaner_service_areas SET ${patch.join(', ')} WHERE id = ?`).run(
    ...values,
    areaId
  );

  return formatCleanerServiceAreaRow(
    db.prepare('SELECT * FROM cleaner_service_areas WHERE id = ?').get(areaId)
  );
}

/**
 * @param {string} userId
 * @param {string} areaId
 */
export function removeServiceArea(userId, areaId) {
  assertCleanerUser(userId);
  const profile = requireProfileRowByUserId(userId);
  assertProfileEditable(profile);

  const area = db
    .prepare('SELECT * FROM cleaner_service_areas WHERE id = ? AND cleaner_profile_id = ?')
    .get(areaId, profile.id);
  assertFound(area, 'Service area not found');

  db.prepare('DELETE FROM cleaner_service_areas WHERE id = ?').run(areaId);
  return { ok: true };
}

export function listServiceAreasForProfileId(profileId) {
  return listAreaRows(profileId);
}
