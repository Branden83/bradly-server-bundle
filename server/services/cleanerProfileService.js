import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { assertFound, ServiceError } from '../lib/serviceError.js';
import { formatCleanerProfileRow } from '../lib/marketplaceFormat.js';
import {
  requireBoolean,
  requireNonNegativeInt,
  requirePositiveInt,
  requireState,
  requireString,
  requireZip,
  requireDayOfWeek,
  requireTime,
  validateProfileStatus,
} from '../validation/marketplace.js';

function loadProfileExtras(profileId) {
  const serviceAreas = db
    .prepare('SELECT * FROM cleaner_service_areas WHERE cleaner_profile_id = ? ORDER BY zip_code')
    .all(profileId);
  const availability = db
    .prepare(
      `SELECT * FROM cleaner_availability WHERE cleaner_profile_id = ? ORDER BY day_of_week, start_time`
    )
    .all(profileId);
  return { serviceAreas, availability };
}

function assertCleanerUser(userId) {
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
  assertFound(user, 'User not found');
  if (user.role !== 'cleaner') {
    throw new ServiceError('Only cleaners can manage a marketplace profile', { status: 403 });
  }
  return user;
}

/**
 * @param {string} userId
 */
export function getProfileByUserId(userId) {
  const row = db.prepare('SELECT * FROM cleaner_profiles WHERE user_id = ?').get(userId);
  if (!row) return null;
  const extras = loadProfileExtras(row.id);
  return formatCleanerProfileRow(row, extras);
}

/**
 * @param {string} profileId
 */
export function getProfileById(profileId) {
  const row = db.prepare('SELECT * FROM cleaner_profiles WHERE id = ?').get(profileId);
  if (!row) return null;
  const extras = loadProfileExtras(row.id);
  return formatCleanerProfileRow(row, extras);
}

/**
 * @param {string} userId
 * @param {object} body
 */
export function createProfile(userId, body) {
  assertCleanerUser(userId);

  const existing = db.prepare('SELECT id FROM cleaner_profiles WHERE user_id = ?').get(userId);
  if (existing) {
    throw new ServiceError('Profile already exists. Use update instead.', { status: 409 });
  }

  const user = db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId);
  const displayName = requireString(body.displayName ?? body.display_name ?? user?.display_name, 'display name', {
    max: 120,
  });
  const bio = body.bio != null ? String(body.bio).trim().slice(0, 2000) : '';
  const experienceYears = requireNonNegativeInt(
    body.experienceYears ?? body.experience_years ?? 0,
    'experience years',
    { max: 60 }
  );
  const hourlyRateCents = requirePositiveInt(
    body.hourlyRateCents ?? body.hourly_rate_cents,
    'hourly rate',
    { min: 100, max: 50000 }
  );
  const minimumVisitMinutes = requirePositiveInt(
    body.minimumVisitMinutes ?? body.minimum_visit_minutes ?? 60,
    'minimum visit minutes',
    { min: 15, max: 480 }
  );
  const minimumVisitCents = requireNonNegativeInt(
    body.minimumVisitCents ?? body.minimum_visit_cents ?? 0,
    'minimum visit charge'
  );
  const acceptsNewClients = body.acceptsNewClients ?? body.accepts_new_clients ?? true;
  const suppliesIncluded = body.suppliesIncluded ?? body.supplies_included ?? false;
  const bringsVacuum = body.bringsVacuum ?? body.brings_vacuum ?? false;
  const languages = body.languages != null ? String(body.languages).trim().slice(0, 500) : '';

  const id = uuid();
  db.prepare(
    `INSERT INTO cleaner_profiles (
      id, user_id, display_name, bio, experience_years,
      hourly_rate_cents, minimum_visit_minutes, minimum_visit_cents,
      accepts_new_clients, supplies_included, brings_vacuum, languages,
      profile_status, background_check_status, insurance_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'not_provided', 'not_provided')`
  ).run(
    id,
    userId,
    displayName,
    bio,
    experienceYears,
    hourlyRateCents,
    minimumVisitMinutes,
    minimumVisitCents,
    acceptsNewClients ? 1 : 0,
    suppliesIncluded ? 1 : 0,
    bringsVacuum ? 1 : 0,
    languages
  );

  return getProfileById(id);
}

/**
 * @param {string} userId
 * @param {object} body
 */
export function updateProfile(userId, body) {
  assertCleanerUser(userId);
  const row = db.prepare('SELECT * FROM cleaner_profiles WHERE user_id = ?').get(userId);
  assertFound(row, 'Profile not found. Create a profile first.');

  if (['suspended', 'rejected'].includes(row.profile_status) && !body._adminOverride) {
    throw new ServiceError('Profile cannot be edited in its current status', { status: 403 });
  }

  const patch = [];
  const patchValues = [];
  if (body.displayName != null || body.display_name != null) {
    patch.push('display_name = ?');
    patchValues.push(requireString(body.displayName ?? body.display_name, 'display name', { max: 120 }));
  }
  if (body.bio != null) {
    patch.push('bio = ?');
    patchValues.push(String(body.bio).trim().slice(0, 2000));
  }
  if (body.experienceYears != null || body.experience_years != null) {
    patch.push('experience_years = ?');
    patchValues.push(
      requireNonNegativeInt(body.experienceYears ?? body.experience_years, 'experience years', { max: 60 })
    );
  }
  if (body.hourlyRateCents != null || body.hourly_rate_cents != null) {
    patch.push('hourly_rate_cents = ?');
    patchValues.push(
      requirePositiveInt(body.hourlyRateCents ?? body.hourly_rate_cents, 'hourly rate', {
        min: 100,
        max: 50000,
      })
    );
  }
  if (body.minimumVisitMinutes != null || body.minimum_visit_minutes != null) {
    patch.push('minimum_visit_minutes = ?');
    patchValues.push(
      requirePositiveInt(body.minimumVisitMinutes ?? body.minimum_visit_minutes, 'minimum visit minutes', {
        min: 15,
        max: 480,
      })
    );
  }
  if (body.minimumVisitCents != null || body.minimum_visit_cents != null) {
    patch.push('minimum_visit_cents = ?');
    patchValues.push(
      requireNonNegativeInt(body.minimumVisitCents ?? body.minimum_visit_cents, 'minimum visit charge')
    );
  }
  if (body.acceptsNewClients != null || body.accepts_new_clients != null) {
    patch.push('accepts_new_clients = ?');
    patchValues.push(body.acceptsNewClients ?? body.accepts_new_clients ? 1 : 0);
  }
  if (body.suppliesIncluded != null || body.supplies_included != null) {
    patch.push('supplies_included = ?');
    patchValues.push(body.suppliesIncluded ?? body.supplies_included ? 1 : 0);
  }
  if (body.bringsVacuum != null || body.brings_vacuum != null) {
    patch.push('brings_vacuum = ?');
    patchValues.push(body.bringsVacuum ?? body.brings_vacuum ? 1 : 0);
  }
  if (body.languages != null) {
    patch.push('languages = ?');
    patchValues.push(String(body.languages).trim().slice(0, 500));
  }

  if (patch.length) {
    patch.push("updated_at = datetime('now')");
    db.prepare(`UPDATE cleaner_profiles SET ${patch.join(', ')} WHERE id = ?`).run(
      ...patchValues,
      row.id
    );
  }

  if (body.submitForReview) {
    db.prepare(
      `UPDATE cleaner_profiles SET profile_status = 'pending_review', updated_at = datetime('now') WHERE id = ?`
    ).run(row.id);
  }

  return getProfileById(row.id);
}

/**
 * @param {string} userId
 * @param {{ zipCode?: string, zip_code?: string, city: string, state: string, radiusMiles?: number }} body
 */
export function addServiceArea(userId, body) {
  assertCleanerUser(userId);
  const profile = db.prepare('SELECT * FROM cleaner_profiles WHERE user_id = ?').get(userId);
  assertFound(profile, 'Create a profile before adding service areas');

  const zipCode = requireZip(body.zipCode ?? body.zip_code);
  const city = requireString(body.city, 'city', { max: 120 });
  const state = requireState(body.state);
  const radiusMiles =
    body.radiusMiles != null || body.radius_miles != null
      ? requirePositiveInt(body.radiusMiles ?? body.radius_miles, 'radius miles', { min: 1, max: 100 })
      : null;

  const dup = db
    .prepare(
      'SELECT id FROM cleaner_service_areas WHERE cleaner_profile_id = ? AND zip_code = ?'
    )
    .get(profile.id, zipCode);
  if (dup) {
    throw new ServiceError('This ZIP is already in your service area', { status: 409 });
  }

  const id = uuid();
  db.prepare(
    `INSERT INTO cleaner_service_areas (id, cleaner_profile_id, zip_code, city, state, radius_miles)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, profile.id, zipCode, city, state, radiusMiles);

  return db.prepare('SELECT * FROM cleaner_service_areas WHERE id = ?').get(id);
}

/**
 * @param {string} userId
 * @param {string} areaId
 */
export function removeServiceArea(userId, areaId) {
  assertCleanerUser(userId);
  const profile = db.prepare('SELECT id FROM cleaner_profiles WHERE user_id = ?').get(userId);
  assertFound(profile, 'Profile not found');

  const area = db
    .prepare('SELECT * FROM cleaner_service_areas WHERE id = ? AND cleaner_profile_id = ?')
    .get(areaId, profile.id);
  assertFound(area, 'Service area not found');

  db.prepare('DELETE FROM cleaner_service_areas WHERE id = ?').run(areaId);
  return { ok: true };
}

/**
 * @param {string} userId
 * @param {object} body
 */
export function addAvailability(userId, body) {
  assertCleanerUser(userId);
  const profile = db.prepare('SELECT * FROM cleaner_profiles WHERE user_id = ?').get(userId);
  assertFound(profile, 'Create a profile before setting availability');

  const dayOfWeek = requireDayOfWeek(body.dayOfWeek ?? body.day_of_week);
  const startTime = requireTime(body.startTime ?? body.start_time, 'start time');
  const endTime = requireTime(body.endTime ?? body.end_time, 'end time');
  const isAvailable = body.isAvailable ?? body.is_available ?? true;

  if (startTime >= endTime) {
    throw new ServiceError('End time must be after start time');
  }

  const id = uuid();
  db.prepare(
    `INSERT INTO cleaner_availability (
      id, cleaner_profile_id, day_of_week, start_time, end_time, is_available
    ) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, profile.id, dayOfWeek, startTime, endTime, isAvailable ? 1 : 0);

  return db.prepare('SELECT * FROM cleaner_availability WHERE id = ?').get(id);
}

/**
 * @param {string} userId
 * @param {string} slotId
 * @param {object} body
 */
export function updateAvailability(userId, slotId, body) {
  assertCleanerUser(userId);
  const profile = db.prepare('SELECT id FROM cleaner_profiles WHERE user_id = ?').get(userId);
  assertFound(profile, 'Profile not found');

  const slot = db
    .prepare('SELECT * FROM cleaner_availability WHERE id = ? AND cleaner_profile_id = ?')
    .get(slotId, profile.id);
  assertFound(slot, 'Availability slot not found');

  const patch = [];
  const values = [];
  if (body.dayOfWeek != null || body.day_of_week != null) {
    patch.push('day_of_week = ?');
    values.push(requireDayOfWeek(body.dayOfWeek ?? body.day_of_week));
  }
  if (body.startTime != null || body.start_time != null) {
    patch.push('start_time = ?');
    values.push(requireTime(body.startTime ?? body.start_time, 'start time'));
  }
  if (body.endTime != null || body.end_time != null) {
    patch.push('end_time = ?');
    values.push(requireTime(body.endTime ?? body.end_time, 'end time'));
  }
  if (body.isAvailable != null || body.is_available != null) {
    patch.push('is_available = ?');
    values.push(body.isAvailable ?? body.is_available ? 1 : 0);
  }

  if (!patch.length) {
    throw new ServiceError('No fields to update');
  }

  patch.push("updated_at = datetime('now')");
  db.prepare(`UPDATE cleaner_availability SET ${patch.join(', ')} WHERE id = ?`).run(
    ...values,
    slotId
  );

  return db.prepare('SELECT * FROM cleaner_availability WHERE id = ?').get(slotId);
}

/**
 * Admin: update profile_status.
 * @param {string} profileId
 * @param {string} status
 * @param {string} [adminNotes]
 */
export function updateProfileStatus(profileId, status, adminNotes) {
  const next = validateProfileStatus(status);
  const row = db.prepare('SELECT * FROM cleaner_profiles WHERE id = ?').get(profileId);
  assertFound(row, 'Profile not found');

  db.prepare(
    `UPDATE cleaner_profiles SET profile_status = ?, admin_notes = COALESCE(?, admin_notes),
     updated_at = datetime('now') WHERE id = ?`
  ).run(next, adminNotes ?? null, profileId);

  return getProfileById(profileId);
}

/**
 * @param {{ status?: string, limit?: number }} [filters]
 */
export function listServiceAreas(userId) {
  const profile = db.prepare('SELECT id FROM cleaner_profiles WHERE user_id = ?').get(userId);
  if (!profile) return [];
  return db
    .prepare('SELECT * FROM cleaner_service_areas WHERE cleaner_profile_id = ? ORDER BY zip_code')
    .all(profile.id);
}

/**
 * @param {string} userId
 */
export function listAvailability(userId) {
  const profile = db.prepare('SELECT id FROM cleaner_profiles WHERE user_id = ?').get(userId);
  if (!profile) return [];
  return db
    .prepare(
      `SELECT * FROM cleaner_availability WHERE cleaner_profile_id = ? ORDER BY day_of_week, start_time`
    )
    .all(profile.id);
}

export function listProfilesForAdmin(filters = {}) {
  const limit = Math.min(filters.limit ?? 100, 200);
  if (filters.status) {
    validateProfileStatus(filters.status);
    return db
      .prepare(
        `SELECT cp.*, u.email FROM cleaner_profiles cp
         JOIN users u ON u.id = cp.user_id
         WHERE cp.profile_status = ?
         ORDER BY cp.updated_at DESC LIMIT ?`
      )
      .all(filters.status, limit);
  }
  return db
    .prepare(
      `SELECT cp.*, u.email FROM cleaner_profiles cp
       JOIN users u ON u.id = cp.user_id
       ORDER BY cp.updated_at DESC LIMIT ?`
    )
    .all(limit);
}
