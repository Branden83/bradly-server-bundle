import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { assertFound, ServiceError } from '../lib/serviceError.js';
import { formatCleanerLanguageRow } from '../lib/marketplaceFormat.js';
import { validateLanguageInput, validateLanguageProficiency } from '../validation/cleanerProfile.js';
import { requireString } from '../validation/marketplace.js';
import {
  assertCleanerUser,
  assertProfileEditable,
  requireProfileRowByUserId,
} from './cleanerProfileHelpers.js';

function listLanguageRows(profileId) {
  return db
    .prepare(
      `SELECT * FROM cleaner_languages
       WHERE cleaner_profile_id = ?
       ORDER BY language_name`
    )
    .all(profileId);
}

/**
 * @param {string} userId
 */
export function listLanguages(userId) {
  const profile = requireProfileRowByUserId(userId);
  return listLanguageRows(profile.id).map(formatCleanerLanguageRow);
}

/**
 * @param {string} userId
 * @param {object} body
 */
export function addLanguage(userId, body) {
  assertCleanerUser(userId);
  const profile = requireProfileRowByUserId(userId);
  assertProfileEditable(profile);

  const input = validateLanguageInput(body);
  const dup = db
    .prepare(
      'SELECT id FROM cleaner_languages WHERE cleaner_profile_id = ? AND language_code = ?'
    )
    .get(profile.id, input.language_code);
  if (dup) {
    throw new ServiceError('This language is already on your profile', { status: 409 });
  }

  const id = uuid();
  db.prepare(
    `INSERT INTO cleaner_languages (
      id, cleaner_profile_id, language_code, language_name, proficiency
    ) VALUES (?, ?, ?, ?, ?)`
  ).run(id, profile.id, input.language_code, input.language_name, input.proficiency);

  return formatCleanerLanguageRow(db.prepare('SELECT * FROM cleaner_languages WHERE id = ?').get(id));
}

/**
 * @param {string} userId
 * @param {string} languageId
 * @param {object} body
 */
export function updateLanguage(userId, languageId, body) {
  assertCleanerUser(userId);
  const profile = requireProfileRowByUserId(userId);
  assertProfileEditable(profile);

  const row = db
    .prepare('SELECT * FROM cleaner_languages WHERE id = ? AND cleaner_profile_id = ?')
    .get(languageId, profile.id);
  assertFound(row, 'Language not found');

  const patch = [];
  const values = [];
  if (body.languageName != null || body.language_name != null) {
    patch.push('language_name = ?');
    values.push(
      requireString(body.languageName ?? body.language_name, 'language name', { max: 120 })
    );
  }
  if (body.proficiency != null) {
    patch.push('proficiency = ?');
    values.push(validateLanguageProficiency(body.proficiency));
  }

  if (!patch.length) {
    throw new ServiceError('No fields to update');
  }

  patch.push("updated_at = datetime('now')");
  db.prepare(`UPDATE cleaner_languages SET ${patch.join(', ')} WHERE id = ?`).run(
    ...values,
    languageId
  );

  return formatCleanerLanguageRow(
    db.prepare('SELECT * FROM cleaner_languages WHERE id = ?').get(languageId)
  );
}

/**
 * @param {string} userId
 * @param {string} languageId
 */
export function deleteLanguage(userId, languageId) {
  assertCleanerUser(userId);
  const profile = requireProfileRowByUserId(userId);
  assertProfileEditable(profile);

  const row = db
    .prepare('SELECT id FROM cleaner_languages WHERE id = ? AND cleaner_profile_id = ?')
    .get(languageId, profile.id);
  assertFound(row, 'Language not found');

  db.prepare('DELETE FROM cleaner_languages WHERE id = ?').run(languageId);
  return { ok: true };
}

export function listLanguagesForProfileId(profileId) {
  return listLanguageRows(profileId);
}
