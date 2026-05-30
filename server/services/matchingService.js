import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { assertFound, ServiceError } from '../lib/serviceError.js';

/**
 * Rule-based match score for a proposal shown to a homeowner.
 * @param {object} proposal
 * @param {object} request
 * @param {object} profile
 */
export function scoreProposalForHomeowner(proposal, request, profile) {
  let score = 50;
  if (profile?.profile_status === 'approved') score += 15;
  if (profile?.accepts_new_clients) score += 5;
  if (proposal.supplies_included) score += 10;

  let preferredDay = request?.preferred_day ?? null;
  if (preferredDay == null && request?.preferred_days) {
    try {
      const days = JSON.parse(request.preferred_days);
      preferredDay = Array.isArray(days) ? days[0] : null;
    } catch {
      preferredDay = Number(request.preferred_days);
    }
  }
  if (preferredDay != null && proposal.proposed_day === preferredDay) {
    score += 10;
  }

  if (request?.homeowner_budget_max_cents && proposal.hourly_rate_cents <= request.homeowner_budget_max_cents) {
    score += 10;
  }

  const scopeMinutes = request?.estimated_minutes || 0;
  if (scopeMinutes > 0) {
    const diff = Math.abs(proposal.recurring_estimated_minutes - scopeMinutes);
    if (diff <= 15) score += 10;
    else if (diff <= 30) score += 5;
  }

  if (profile?.experience_years >= 3) score += 5;
  return Math.min(100, score);
}

/**
 * @param {Array<object>} proposals
 * @param {'best_match' | 'lowest_estimate'} [sort]
 */
export function sortProposals(proposals, sort = 'best_match') {
  const copy = [...proposals];
  if (sort === 'lowest_estimate') {
    return copy.sort(
      (a, b) =>
        (a.recurring_total_cents ?? a.estimated_cost_cents ?? 0) -
        (b.recurring_total_cents ?? b.estimated_cost_cents ?? 0)
    );
  }
  return copy.sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0));
}

function scoreCleanerForRequest(profile, serviceAreas, availability, request) {
  let score = 0;
  const reasons = [];
  const warnings = [];

  const servesZip = serviceAreas.some((a) => a.zip_code === request.zip_code);
  if (servesZip) {
    score += 30;
    reasons.push(`Serves ZIP ${request.zip_code}`);
  } else {
    warnings.push('Outside primary service area');
  }

  if (profile.profile_status === 'approved') {
    score += 20;
    reasons.push('Approved profile');
  }

  if (profile.accepts_new_clients) {
    score += 10;
    reasons.push('Accepting new clients');
  }

  let preferredDay = null;
  if (request.preferred_days) {
    try {
      const days = JSON.parse(request.preferred_days);
      preferredDay = Array.isArray(days) ? days[0] : null;
    } catch {
      preferredDay = Number(request.preferred_days);
    }
  }

  if (preferredDay != null) {
    const dayMatch = availability.some((a) => a.is_available && a.day_of_week === preferredDay);
    if (dayMatch) {
      score += 15;
      reasons.push('Available on preferred day');
    } else {
      warnings.push('Preferred day mismatch');
    }
  }

  if (request.homeowner_budget_max_cents && profile.hourly_rate_cents <= request.homeowner_budget_max_cents) {
    score += 15;
    reasons.push('Rate fits homeowner budget');
  } else if (request.homeowner_budget_max_cents) {
    warnings.push('Rate above stated budget');
  } else {
    score += 5;
    reasons.push('Rate listed');
  }

  if (profile.supplies_included || request.supplies_available) {
    score += 10;
    reasons.push('Supplies compatible');
  }

  if (profile.bio?.length > 20) score += 5;
  if (serviceAreas.length > 0) score += 5;

  return {
    cleaner_profile_id: profile.id,
    user_id: profile.user_id,
    display_name: profile.display_name,
    score: Math.min(100, score),
    reasons,
    warnings,
  };
}

export function rankCleanersForRequest(requestId) {
  const request = db.prepare('SELECT * FROM cleaning_requests WHERE id = ?').get(requestId);
  assertFound(request, 'Cleaning request not found');

  const profiles = db
    .prepare(
      `SELECT cp.*, u.display_name as user_display_name
       FROM cleaner_profiles cp
       JOIN users u ON u.id = cp.user_id
       WHERE cp.profile_status = 'approved' AND cp.accepts_new_clients = 1`
    )
    .all();

  const results = [];
  for (const profile of profiles) {
    const serviceAreas = db
      .prepare('SELECT * FROM cleaner_service_areas WHERE cleaner_profile_id = ?')
      .all(profile.id);
    const availability = db
      .prepare('SELECT * FROM cleaner_availability WHERE cleaner_profile_id = ?')
      .all(profile.id);

    if (!serviceAreas.some((a) => a.zip_code === request.zip_code)) continue;

    results.push(
      scoreCleanerForRequest(
        { ...profile, display_name: profile.display_name || profile.user_display_name },
        serviceAreas,
        availability,
        request
      )
    );
  }

  return results.sort((a, b) => b.score - a.score);
}

export function createMatchSuggestion(requestId, adminUserId, { cleanerProfileId, score, reasons }) {
  const request = db.prepare('SELECT id FROM cleaning_requests WHERE id = ?').get(requestId);
  assertFound(request, 'Cleaning request not found');

  const profile = db.prepare('SELECT id FROM cleaner_profiles WHERE id = ?').get(cleanerProfileId);
  assertFound(profile, 'Cleaner profile not found');

  const id = uuid();
  db.prepare(
    `INSERT INTO admin_match_suggestions (
      id, request_id, cleaner_profile_id, suggested_by_admin_id, score, reasons_json, status
    ) VALUES (?, ?, ?, ?, ?, ?, 'suggested')`
  ).run(
    id,
    requestId,
    cleanerProfileId,
    adminUserId,
    score ?? null,
    JSON.stringify(reasons || [])
  );

  return db.prepare('SELECT * FROM admin_match_suggestions WHERE id = ?').get(id);
}

export function suggestCleanersForRequest(requestId, adminUserId) {
  const ranked = rankCleanersForRequest(requestId);
  const created = [];

  for (const match of ranked.slice(0, 5)) {
    const existing = db
      .prepare(
        `SELECT id FROM admin_match_suggestions
         WHERE request_id = ? AND cleaner_profile_id = ? AND status = 'suggested'`
      )
      .get(requestId, match.cleaner_profile_id);
    if (existing) continue;

    created.push(
      createMatchSuggestion(requestId, adminUserId, {
        cleanerProfileId: match.cleaner_profile_id,
        score: match.score,
        reasons: match.reasons,
      })
    );
  }

  return { suggestions: created, ranked };
}

export function listMatchSuggestions(requestId = null) {
  if (requestId) {
    return db
      .prepare(
        `SELECT s.*, cp.display_name as cleaner_name, u.email as cleaner_email
         FROM admin_match_suggestions s
         JOIN cleaner_profiles cp ON cp.id = s.cleaner_profile_id
         JOIN users u ON u.id = cp.user_id
         WHERE s.request_id = ?
         ORDER BY s.score DESC, s.created_at DESC`
      )
      .all(requestId);
  }

  return db
    .prepare(
      `SELECT s.*, cp.display_name as cleaner_name, cr.zip_code, cr.city, cr.state
       FROM admin_match_suggestions s
       JOIN cleaner_profiles cp ON cp.id = s.cleaner_profile_id
       JOIN cleaning_requests cr ON cr.id = s.request_id
       ORDER BY s.created_at DESC
       LIMIT 100`
    )
    .all();
}

export function manualSuggestion(requestId, adminUserId, body) {
  const { cleanerProfileId, score, reasons, status } = body;
  if (!cleanerProfileId) throw new ServiceError('cleanerProfileId is required');

  const suggestion = createMatchSuggestion(requestId, adminUserId, {
    cleanerProfileId,
    score,
    reasons,
  });

  if (status && status !== 'suggested') {
    db.prepare(
      `UPDATE admin_match_suggestions SET status = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(status, suggestion.id);
  }

  return db.prepare('SELECT * FROM admin_match_suggestions WHERE id = ?').get(suggestion.id);
}
