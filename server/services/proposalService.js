import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { assertFound, ServiceError } from '../lib/serviceError.js';
import { formatProposalRow } from '../lib/marketplaceFormat.js';
import { validateProposalSendInput } from '../validation/marketplace.js';
import { calculateProposalEstimates } from './estimateService.js';
import { scoreProposalForHomeowner, sortProposals } from './matchingService.js';
import * as cleaningRequestService from './cleaningRequestService.js';
import { createFromAcceptedProposal } from './agreementService.js';

const ACTIVE_PROPOSAL_STATUSES = new Set(['sent', 'viewed']);

function getProposalRow(id) {
  return db.prepare('SELECT * FROM cleaner_proposals WHERE id = ?').get(id);
}

function assertCleanerCanPropose(cleanerUserId) {
  const profile = db.prepare('SELECT * FROM cleaner_profiles WHERE user_id = ?').get(cleanerUserId);
  assertFound(profile, 'Create a cleaner profile before sending proposals');
  if (profile.profile_status !== 'approved') {
    throw new ServiceError('Your profile must be approved before you can send proposals', {
      status: 403,
    });
  }
  if (!profile.accepts_new_clients) {
    throw new ServiceError('Enable "accepting new clients" on your profile to send proposals', {
      status: 403,
    });
  }
  return profile;
}

function enrichProposal(row, request) {
  const profile = db
    .prepare('SELECT * FROM cleaner_profiles WHERE id = ?')
    .get(row.cleaner_profile_id);
  const cleaner = db.prepare('SELECT display_name FROM users WHERE id = ?').get(row.cleaner_id);
  const serviceAreas = profile
    ? db
        .prepare('SELECT * FROM cleaner_service_areas WHERE cleaner_profile_id = ?')
        .all(profile.id)
    : [];
  const match = scoreProposalForHomeowner(row, request, profile, serviceAreas);
  let agreementId = null;
  if (row.status === 'accepted') {
    const agreement = db
      .prepare('SELECT id FROM household_cleaner_agreements WHERE accepted_proposal_id = ?')
      .get(row.id);
    agreementId = agreement?.id ?? null;
  }
  return formatProposalRow(row, {
    cleanerName: profile?.display_name || cleaner?.display_name,
    matchScore: match.score,
    distanceMiles: match.distance_miles,
    distanceLabel: match.distance_label,
    matchReasons: match.reasons,
    agreementId,
  });
}

/**
 * @param {string} requestId
 * @param {string} cleanerUserId
 * @param {object} body
 */
export function sendProposal(requestId, cleanerUserId, body) {
  const profile = assertCleanerCanPropose(cleanerUserId);
  const request = db.prepare('SELECT * FROM cleaning_requests WHERE id = ?').get(requestId);
  assertFound(request, 'Cleaning request not found');

  if (!['open', 'proposals_received'].includes(request.status)) {
    throw new ServiceError('This request is not accepting proposals');
  }

  cleaningRequestService.getRequestForCleaner(requestId, cleanerUserId);

  const existing = db
    .prepare(
      `SELECT id FROM cleaner_proposals
       WHERE request_id = ? AND cleaner_id = ? AND status IN ('sent', 'viewed', 'accepted')`
    )
    .get(requestId, cleanerUserId);
  if (existing) {
    throw new ServiceError('You already sent a proposal for this request', { status: 409 });
  }

  const input = validateProposalSendInput(body);
  const minimumVisitMinutes =
    input.minimum_visit_minutes ?? profile.minimum_visit_minutes ?? 60;
  const minimumVisitCents = input.minimum_visit_cents ?? profile.minimum_visit_cents ?? 0;

  const estimates = calculateProposalEstimates({
    hourlyRateCents: input.hourly_rate_cents,
    firstVisitMinutes: input.first_visit_estimated_minutes,
    recurringVisitMinutes: input.recurring_estimated_minutes,
    minimumVisitMinutes,
    minimumVisitCents,
  });

  const id = uuid();
  db.prepare(
    `INSERT INTO cleaner_proposals (
      id, request_id, cleaner_id, cleaner_profile_id,
      hourly_rate_cents, minimum_visit_minutes, minimum_visit_cents,
      first_visit_estimated_minutes, first_visit_total_cents,
      recurring_estimated_minutes, recurring_total_cents,
      supplies_included, proposed_day, proposed_start_time, proposed_end_time,
      message, adjustment_reason, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent')`
  ).run(
    id,
    requestId,
    cleanerUserId,
    profile.id,
    input.hourly_rate_cents,
    minimumVisitMinutes,
    minimumVisitCents,
    estimates.first_visit_estimated_minutes,
    estimates.first_visit_total_cents,
    estimates.recurring_estimated_minutes,
    estimates.recurring_total_cents,
    input.supplies_included,
    input.proposed_day,
    input.proposed_start_time,
    input.proposed_end_time,
    input.message ?? '',
    input.adjustment_reason ?? '',
  );

  cleaningRequestService.markProposalsReceived(requestId);

  const row = getProposalRow(id);
  return enrichProposal(row, request);
}

/**
 * @param {string} proposalId
 * @param {string} cleanerUserId
 * @param {object} body
 */
export function updateProposal(proposalId, cleanerUserId, body) {
  const row = getProposalRow(proposalId);
  assertFound(row, 'Proposal not found');
  if (row.cleaner_id !== cleanerUserId) {
    throw new ServiceError('Not allowed', { status: 403 });
  }
  if (!ACTIVE_PROPOSAL_STATUSES.has(row.status)) {
    throw new ServiceError('This proposal can no longer be edited');
  }

  const merged = {
    hourlyRateCents: body.hourlyRateCents ?? body.hourly_rate_cents ?? row.hourly_rate_cents,
    firstVisitEstimatedMinutes:
      body.firstVisitEstimatedMinutes ??
      body.first_visit_estimated_minutes ??
      row.first_visit_estimated_minutes,
    recurringEstimatedMinutes:
      body.recurringEstimatedMinutes ??
      body.recurring_estimated_minutes ??
      row.recurring_estimated_minutes,
    minimumVisitMinutes: body.minimumVisitMinutes ?? body.minimum_visit_minutes ?? row.minimum_visit_minutes,
    minimumVisitCents: body.minimumVisitCents ?? body.minimum_visit_cents ?? row.minimum_visit_cents,
    suppliesIncluded: body.suppliesIncluded ?? body.supplies_included ?? row.supplies_included,
    proposedDay: body.proposedDay ?? body.proposed_day ?? row.proposed_day,
    proposedStartTime: body.proposedStartTime ?? body.proposed_start_time ?? row.proposed_start_time,
    proposedEndTime: body.proposedEndTime ?? body.proposed_end_time ?? row.proposed_end_time,
    message: body.message !== undefined ? body.message : row.message,
    adjustmentReason: body.adjustmentReason ?? body.adjustment_reason ?? row.adjustment_reason,
  };
  const input = validateProposalSendInput(merged);
  const estimates = calculateProposalEstimates({
    hourlyRateCents: input.hourly_rate_cents,
    firstVisitMinutes: input.first_visit_estimated_minutes,
    recurringVisitMinutes: input.recurring_estimated_minutes,
    minimumVisitMinutes: input.minimum_visit_minutes ?? row.minimum_visit_minutes,
    minimumVisitCents: input.minimum_visit_cents ?? row.minimum_visit_cents,
  });

  db.prepare(
    `UPDATE cleaner_proposals SET
      hourly_rate_cents = ?,
      minimum_visit_minutes = ?,
      minimum_visit_cents = ?,
      first_visit_estimated_minutes = ?,
      first_visit_total_cents = ?,
      recurring_estimated_minutes = ?,
      recurring_total_cents = ?,
      supplies_included = ?,
      proposed_day = ?,
      proposed_start_time = ?,
      proposed_end_time = ?,
      message = ?,
      adjustment_reason = ?,
      updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    input.hourly_rate_cents,
    input.minimum_visit_minutes ?? row.minimum_visit_minutes,
    input.minimum_visit_cents ?? row.minimum_visit_cents,
    estimates.first_visit_estimated_minutes,
    estimates.first_visit_total_cents,
    estimates.recurring_estimated_minutes,
    estimates.recurring_total_cents,
    input.supplies_included,
    input.proposed_day,
    input.proposed_start_time,
    input.proposed_end_time,
    input.message ?? '',
    input.adjustment_reason ?? '',
    proposalId
  );

  const request = db.prepare('SELECT * FROM cleaning_requests WHERE id = ?').get(row.request_id);
  return enrichProposal(getProposalRow(proposalId), request);
}

/**
 * @param {string} proposalId
 * @param {string} cleanerUserId
 */
export function withdrawProposal(proposalId, cleanerUserId) {
  const row = getProposalRow(proposalId);
  assertFound(row, 'Proposal not found');
  if (row.cleaner_id !== cleanerUserId) {
    throw new ServiceError('Not allowed', { status: 403 });
  }
  if (!ACTIVE_PROPOSAL_STATUSES.has(row.status)) {
    throw new ServiceError('This proposal cannot be withdrawn');
  }

  db.prepare(
    `UPDATE cleaner_proposals SET status = 'withdrawn', updated_at = datetime('now') WHERE id = ?`
  ).run(proposalId);

  return getProposalRow(proposalId);
}

/**
 * @param {string} requestId
 * @param {string} homeownerId
 * @param {{ sort?: 'best_match' | 'lowest_estimate' }} [opts]
 */
export function listProposalsForHomeowner(requestId, homeownerId, opts = {}) {
  const request = db.prepare('SELECT * FROM cleaning_requests WHERE id = ?').get(requestId);
  assertFound(request, 'Cleaning request not found');
  if (request.homeowner_id !== homeownerId) {
    throw new ServiceError('Not allowed', { status: 403 });
  }

  const rows = db
    .prepare(
      `SELECT * FROM cleaner_proposals
       WHERE request_id = ? AND status IN ('sent', 'viewed', 'accepted')
       ORDER BY created_at DESC`
    )
    .all(requestId);

  const proposals = rows.map((row) => enrichProposal(row, request));
  return sortProposals(proposals, opts.sort ?? 'best_match');
}

/**
 * @param {string} proposalId
 * @param {string} cleanerUserId
 */
export function getProposalForCleaner(proposalId, cleanerUserId) {
  const row = getProposalRow(proposalId);
  assertFound(row, 'Proposal not found');
  if (row.cleaner_id !== cleanerUserId) {
    throw new ServiceError('Not allowed', { status: 403 });
  }
  const request = db.prepare('SELECT * FROM cleaning_requests WHERE id = ?').get(row.request_id);
  return enrichProposal(row, request);
}

/**
 * @param {string} proposalId
 */
export function getProposalById(proposalId) {
  const row = getProposalRow(proposalId);
  assertFound(row, 'Proposal not found');
  const request = db.prepare('SELECT * FROM cleaning_requests WHERE id = ?').get(row.request_id);
  return enrichProposal(row, request);
}

/**
 * @param {string} proposalId
 * @param {string} homeownerId
 */
export function declineProposal(proposalId, homeownerId) {
  const row = getProposalRow(proposalId);
  assertFound(row, 'Proposal not found');
  const request = db.prepare('SELECT * FROM cleaning_requests WHERE id = ?').get(row.request_id);
  assertFound(request, 'Cleaning request not found');
  if (request.homeowner_id !== homeownerId) {
    throw new ServiceError('Not allowed', { status: 403 });
  }
  if (!ACTIVE_PROPOSAL_STATUSES.has(row.status)) {
    throw new ServiceError('This proposal cannot be declined');
  }

  db.prepare(
    `UPDATE cleaner_proposals SET status = 'declined', updated_at = datetime('now') WHERE id = ?`
  ).run(proposalId);

  return getProposalRow(proposalId);
}

/**
 * @param {string} cleanerUserId
 */
/**
 * Homeowner accepts proposal → agreement + household (delegates to agreementService).
 * @param {string} proposalId
 * @param {string} homeownerId
 */
export function acceptProposal(proposalId, homeownerId) {
  return createFromAcceptedProposal(proposalId, homeownerId);
}

export function listProposalsForCleaner(cleanerUserId) {
  const rows = db
    .prepare(
      `SELECT p.* FROM cleaner_proposals p
       WHERE p.cleaner_id = ?
       ORDER BY p.created_at DESC LIMIT 50`
    )
    .all(cleanerUserId);

  return rows.map((row) => {
    const request = db.prepare('SELECT * FROM cleaning_requests WHERE id = ?').get(row.request_id);
    return enrichProposal(row, request);
  });
}
