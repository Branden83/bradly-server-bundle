import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { assertFound, ServiceError } from '../lib/serviceError.js';
import {
  formatCleanerProfilePublicRow,
  formatCleanerProfileRow,
} from '../lib/marketplaceFormat.js';
import { validateProfileInput, validateProfileStatus } from '../validation/cleanerProfile.js';
import {
  assertCleanerUser,
  assertProfileEditable,
  getProfileRowByUserId,
  requireProfileRowByUserId,
} from './cleanerProfileHelpers.js';
import { listAvailabilityForProfileId } from './cleanerAvailabilityService.js';
import { listLanguagesForProfileId } from './cleanerLanguageService.js';
import { listServicesForProfileId } from './cleanerServicesService.js';
import { listServiceAreasForProfileId } from './cleanerServiceAreaService.js';
import { assertReadyForReview, getProfileCompletion } from './profileCompletionService.js';

// Re-export sub-services for backward compatibility with existing routes.
export {
  addServiceArea,
  listServiceAreas,
  removeServiceArea,
  updateServiceArea,
} from './cleanerServiceAreaService.js';
export {
  addAvailability,
  deleteAvailability,
  listAvailability,
  updateAvailability,
} from './cleanerAvailabilityService.js';

function loadProfileExtras(profileId) {
  return {
    serviceAreas: listServiceAreasForProfileId(profileId),
    availability: listAvailabilityForProfileId(profileId),
    languages: listLanguagesForProfileId(profileId),
    services: listServicesForProfileId(profileId),
  };
}

function formatFullProfile(row, { includeAdminNotes = true } = {}) {
  const extras = loadProfileExtras(row.id);
  return formatCleanerProfileRow(row, { ...extras, includeAdminNotes });
}

/**
 * @param {string} userId
 * @param {{ includeAdminNotes?: boolean }} [options]
 */
export function getProfileByUserId(userId, { includeAdminNotes = true } = {}) {
  const row = getProfileRowByUserId(userId);
  if (!row) return null;
  return formatFullProfile(row, { includeAdminNotes });
}

/**
 * @param {string} profileId
 * @param {{ includeAdminNotes?: boolean }} [options]
 */
export function getProfileById(profileId, { includeAdminNotes = true } = {}) {
  const row = db.prepare('SELECT * FROM cleaner_profiles WHERE id = ?').get(profileId);
  if (!row) return null;
  return formatFullProfile(row, { includeAdminNotes });
}

/**
 * Public / match-safe profile — no admin_notes.
 * @param {string} profileId
 */
export function getPublicProfileById(profileId) {
  const row = db.prepare('SELECT * FROM cleaner_profiles WHERE id = ?').get(profileId);
  if (!row) return null;
  const extras = loadProfileExtras(row.id);
  return formatCleanerProfilePublicRow(row, extras);
}

/**
 * @param {string} userId
 * @param {object} body
 */
export function createProfile(userId, body) {
  assertCleanerUser(userId);

  const existing = getProfileRowByUserId(userId);
  if (existing) {
    throw new ServiceError('Profile already exists. Use update instead.', { status: 409 });
  }

  const user = db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId);
  const input = validateProfileInput(
    {
      ...body,
      displayName: body.displayName ?? body.display_name ?? user?.display_name,
      acceptsNewClients: body.acceptsNewClients ?? body.accepts_new_clients ?? false,
    },
    { forCreate: true }
  );

  const id = uuid();
  db.prepare(
    `INSERT INTO cleaner_profiles (
      id, user_id, display_name, profile_photo_url, bio, experience_years,
      hourly_rate_cents, minimum_visit_minutes, minimum_visit_cents,
      accepts_new_clients, supplies_included, brings_vacuum,
      pet_comfort_level, fragrance_free_available, eco_friendly_products_available,
      bleach_allowed, deep_cleaning_available, move_in_move_out_available,
      recurring_cleaning_available, one_time_cleaning_available,
      profile_status, background_check_status, insurance_status, stripe_onboarding_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'not_provided', 'not_provided', 'not_started')`
  ).run(
    id,
    userId,
    input.display_name,
    input.profile_photo_url ?? null,
    input.bio ?? '',
    input.experience_years ?? null,
    input.hourly_rate_cents ?? null,
    input.minimum_visit_minutes ?? null,
    input.minimum_visit_cents ?? null,
    input.accepts_new_clients ?? 0,
    input.supplies_included ?? 0,
    input.brings_vacuum ?? 0,
    input.pet_comfort_level ?? 'none',
    input.fragrance_free_available ?? 0,
    input.eco_friendly_products_available ?? 0,
    input.bleach_allowed ?? 1,
    input.deep_cleaning_available ?? 0,
    input.move_in_move_out_available ?? 0,
    input.recurring_cleaning_available ?? 1,
    input.one_time_cleaning_available ?? 1
  );

  return getProfileById(id);
}

/**
 * @param {string} userId
 * @param {object} body
 */
export function updateProfile(userId, body) {
  assertCleanerUser(userId);
  const row = requireProfileRowByUserId(userId);
  assertProfileEditable(row, { adminOverride: body._adminOverride });

  const input = validateProfileInput(body);
  const patch = [];
  const values = [];

  for (const [column, value] of Object.entries(input)) {
    patch.push(`${column} = ?`);
    values.push(value);
  }

  if (patch.length) {
    patch.push("updated_at = datetime('now')");
    db.prepare(`UPDATE cleaner_profiles SET ${patch.join(', ')} WHERE id = ?`).run(
      ...values,
      row.id
    );
  }

  if (body.submitForReview) {
    return submitForReview(userId);
  }

  return getProfileById(row.id);
}

/**
 * @param {string} userId
 */
export function submitForReview(userId) {
  assertCleanerUser(userId);
  const row = requireProfileRowByUserId(userId);
  assertProfileEditable(row);

  if (row.profile_status === 'pending_review') {
    throw new ServiceError('Profile is already pending review', { status: 409 });
  }
  if (row.profile_status === 'approved') {
    throw new ServiceError('Approved profiles cannot be resubmitted for review', { status: 409 });
  }

  assertReadyForReview(userId);

  db.prepare(
    `UPDATE cleaner_profiles
     SET profile_status = 'pending_review', updated_at = datetime('now')
     WHERE id = ?`
  ).run(row.id);

  return getProfileById(row.id);
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
 * Admin: update admin_notes only.
 * @param {string} profileId
 * @param {string} adminNotes
 */
export function updateAdminNotes(profileId, adminNotes) {
  const row = db.prepare('SELECT * FROM cleaner_profiles WHERE id = ?').get(profileId);
  assertFound(row, 'Profile not found');

  const notes =
    adminNotes != null ? String(adminNotes).trim().slice(0, 5000) : '';

  db.prepare(
    `UPDATE cleaner_profiles SET admin_notes = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(notes, profileId);

  return getProfileById(profileId);
}

/**
 * @param {{ status?: string, limit?: number }} [filters]
 */
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

/**
 * @param {string} userId
 */
export function getProfileCompletionSummary(userId) {
  assertCleanerUser(userId);
  return getProfileCompletion(userId);
}
