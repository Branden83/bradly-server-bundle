import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { assertFound, ServiceError } from '../lib/serviceError.js';
import { formatCleanerServiceRow } from '../lib/marketplaceFormat.js';
import {
  SERVICE_CATALOG,
  validateOfferedServiceInput,
  validateServiceKey,
} from '../validation/cleanerProfile.js';
import {
  assertCleanerUser,
  assertProfileEditable,
  requireProfileRowByUserId,
} from './cleanerProfileHelpers.js';

export { SERVICE_CATALOG };

function listServiceRows(profileId) {
  return db
    .prepare(
      `SELECT * FROM cleaner_services
       WHERE cleaner_profile_id = ?
       ORDER BY service_label`
    )
    .all(profileId);
}

/**
 * @param {string} userId
 */
export function listServices(userId) {
  const profile = requireProfileRowByUserId(userId);
  return listServiceRows(profile.id).map(formatCleanerServiceRow);
}

/**
 * @param {string} userId
 * @param {object} body
 */
export function upsertService(userId, body) {
  assertCleanerUser(userId);
  const profile = requireProfileRowByUserId(userId);
  assertProfileEditable(profile);

  const input = validateOfferedServiceInput(body);
  const existing = db
    .prepare(
      'SELECT id FROM cleaner_services WHERE cleaner_profile_id = ? AND service_key = ?'
    )
    .get(profile.id, input.service_key);

  if (existing) {
    db.prepare(
      `UPDATE cleaner_services
       SET service_label = ?, is_offered = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(input.service_label, input.is_offered, existing.id);
    return formatCleanerServiceRow(
      db.prepare('SELECT * FROM cleaner_services WHERE id = ?').get(existing.id)
    );
  }

  const id = uuid();
  db.prepare(
    `INSERT INTO cleaner_services (
      id, cleaner_profile_id, service_key, service_label, is_offered
    ) VALUES (?, ?, ?, ?, ?)`
  ).run(id, profile.id, input.service_key, input.service_label, input.is_offered);

  return formatCleanerServiceRow(db.prepare('SELECT * FROM cleaner_services WHERE id = ?').get(id));
}

/**
 * @param {string} userId
 * @param {string} serviceId
 * @param {object} body
 */
export function updateService(userId, serviceId, body) {
  assertCleanerUser(userId);
  const profile = requireProfileRowByUserId(userId);
  assertProfileEditable(profile);

  const row = db
    .prepare('SELECT * FROM cleaner_services WHERE id = ? AND cleaner_profile_id = ?')
    .get(serviceId, profile.id);
  assertFound(row, 'Service not found');

  const patch = [];
  const values = [];
  if (body.serviceLabel != null || body.service_label != null) {
    patch.push('service_label = ?');
    values.push(
      validateOfferedServiceInput({
        service_key: row.service_key,
        service_label: body.serviceLabel ?? body.service_label,
      }).service_label
    );
  }
  if (body.isOffered != null || body.is_offered != null) {
    patch.push('is_offered = ?');
    values.push(body.isOffered ?? body.is_offered ? 1 : 0);
  }

  if (!patch.length) {
    throw new ServiceError('No fields to update');
  }

  patch.push("updated_at = datetime('now')");
  db.prepare(`UPDATE cleaner_services SET ${patch.join(', ')} WHERE id = ?`).run(
    ...values,
    serviceId
  );

  return formatCleanerServiceRow(
    db.prepare('SELECT * FROM cleaner_services WHERE id = ?').get(serviceId)
  );
}

/**
 * @param {string} userId
 * @param {string} serviceKeyOrId - service_key or row id
 */
export function deleteService(userId, serviceKeyOrId) {
  assertCleanerUser(userId);
  const profile = requireProfileRowByUserId(userId);
  assertProfileEditable(profile);

  let row = db
    .prepare('SELECT * FROM cleaner_services WHERE id = ? AND cleaner_profile_id = ?')
    .get(serviceKeyOrId, profile.id);
  if (!row) {
    const key = validateServiceKey(serviceKeyOrId);
    row = db
      .prepare('SELECT * FROM cleaner_services WHERE service_key = ? AND cleaner_profile_id = ?')
      .get(key, profile.id);
  }
  assertFound(row, 'Service not found');

  db.prepare('DELETE FROM cleaner_services WHERE id = ?').run(row.id);
  return { ok: true };
}

/**
 * Replace offered services in one request.
 * @param {string} userId
 * @param {string[]} serviceKeys
 */
export function setOfferedServices(userId, serviceKeys) {
  assertCleanerUser(userId);
  const profile = requireProfileRowByUserId(userId);
  assertProfileEditable(profile);

  if (!Array.isArray(serviceKeys) || !serviceKeys.length) {
    throw new ServiceError('At least one service key is required');
  }

  const normalized = [...new Set(serviceKeys.map((key) => validateServiceKey(key)))];
  const keepKeys = new Set(normalized);

  const existing = listServiceRows(profile.id);
  for (const row of existing) {
    if (!keepKeys.has(row.service_key)) {
      db.prepare('DELETE FROM cleaner_services WHERE id = ?').run(row.id);
    }
  }

  for (const serviceKey of normalized) {
    upsertService(userId, { service_key: serviceKey, is_offered: true });
  }

  return listServices(userId);
}

export function listServicesForProfileId(profileId) {
  return listServiceRows(profileId);
}

export function listOfferedServicesForProfileId(profileId) {
  return listServiceRows(profileId).filter((row) => row.is_offered);
}
