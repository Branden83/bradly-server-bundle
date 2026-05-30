import db from '../db.js';
import { assertFound, ServiceError } from '../lib/serviceError.js';

/**
 * @param {string} userId
 */
export function assertCleanerUser(userId) {
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
export function getProfileRowByUserId(userId) {
  return db.prepare('SELECT * FROM cleaner_profiles WHERE user_id = ?').get(userId) ?? null;
}

/**
 * @param {string} userId
 */
export function requireProfileRowByUserId(userId) {
  return assertFound(getProfileRowByUserId(userId), 'Profile not found. Create a profile first.');
}

/**
 * @param {object} row
 * @param {{ adminOverride?: boolean }} [options]
 */
export function assertProfileEditable(row, { adminOverride = false } = {}) {
  if (adminOverride) return;
  if (['suspended', 'rejected'].includes(row.profile_status)) {
    throw new ServiceError('Profile cannot be edited in its current status', { status: 403 });
  }
}
