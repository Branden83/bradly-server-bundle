import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { assertFound, ServiceError } from '../lib/serviceError.js';
import { formatAgreementRow } from '../lib/marketplaceFormat.js';
import * as cleaningRequestService from './cleaningRequestService.js';

function buildScopeSummary(tasks) {
  if (!tasks?.length) return 'Cleaning agreement';
  const rooms = new Set(tasks.map((t) => t.room_name));
  return `${tasks.length} tasks across ${rooms.size} area${rooms.size === 1 ? '' : 's'}`;
}

/**
 * Connect cleaner to household via home_members (BYOC and Match).
 * Does not modify invites table — BYOC invite redemption stays in route handler.
 *
 * @param {string} homeId
 * @param {string} cleanerId
 */
export function connectCleanerToHousehold(homeId, cleanerId) {
  const home = db.prepare('SELECT * FROM homes WHERE id = ?').get(homeId);
  assertFound(home, 'Household not found');

  const cleaner = db.prepare('SELECT id, role FROM users WHERE id = ?').get(cleanerId);
  assertFound(cleaner, 'Cleaner not found');
  if (cleaner.role !== 'cleaner') {
    throw new ServiceError('User is not a cleaner');
  }

  db.prepare(
    `INSERT OR IGNORE INTO home_members (home_id, user_id, role) VALUES (?, ?, 'cleaner')`
  ).run(homeId, cleanerId);

  return db
    .prepare('SELECT * FROM home_members WHERE home_id = ? AND user_id = ?')
    .get(homeId, cleanerId);
}

/**
 * Seed rooms and task_templates from cleaning request tasks.
 * @param {string} homeId
 * @param {Array<object>} requestTasks
 */
function seedHomeFromRequestTasks(homeId, requestTasks) {
  const roomInsert = db.prepare(
    'INSERT INTO rooms (id, home_id, name, sort_order) VALUES (?, ?, ?, ?)'
  );
  const taskInsert = db.prepare(
    `INSERT INTO task_templates (id, room_id, title, instructions, cadence, estimated_minutes, priority)
     VALUES (?, ?, ?, ?, ?, ?, 'must')`
  );

  const roomIds = new Map();
  let sortOrder = 0;

  for (const task of requestTasks) {
    if (!roomIds.has(task.room_name)) {
      const roomId = uuid();
      roomInsert.run(roomId, homeId, task.room_name, sortOrder++);
      roomIds.set(task.room_name, roomId);
    }
    taskInsert.run(
      uuid(),
      roomIds.get(task.room_name),
      task.task_name,
      task.notes || '',
      task.cadence,
      task.estimated_minutes
    );
  }
}

/**
 * Create household from match request + accepted proposal.
 * @param {string} homeownerId
 * @param {object} request
 * @param {object} proposal
 */
function createHouseholdFromMatch(homeownerId, request, proposal) {
  const existing = db.prepare('SELECT id FROM homes WHERE owner_id = ?').get(homeownerId);
  if (existing) {
    connectCleanerToHousehold(existing.id, proposal.cleaner_id);
    db.prepare(
      `UPDATE homes SET
        hourly_rate_cents = COALESCE(?, hourly_rate_cents),
        visit_day = COALESCE(?, visit_day),
        visit_time = COALESCE(?, visit_time)
       WHERE id = ?`
    ).run(
      proposal.hourly_rate_cents,
      proposal.proposed_day,
      proposal.proposed_start_time || '10:00',
      existing.id
    );
    return existing.id;
  }

  const homeId = uuid();
  const visitDay = proposal.proposed_day ?? 2;
  const visitTime = proposal.proposed_start_time || '10:00';

  db.prepare(
    `INSERT INTO homes (id, owner_id, name, visit_day, visit_time, hourly_rate_cents)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    homeId,
    homeownerId,
    request.city ? `${request.city} Home` : 'My Home',
    visitDay,
    visitTime,
    proposal.hourly_rate_cents
  );

  db.prepare('INSERT INTO home_members (home_id, user_id, role) VALUES (?, ?, ?)').run(
    homeId,
    homeownerId,
    'owner'
  );

  const tasks = db
    .prepare('SELECT * FROM cleaning_request_tasks WHERE request_id = ? ORDER BY sort_order')
    .all(request.id);
  seedHomeFromRequestTasks(homeId, tasks);

  connectCleanerToHousehold(homeId, proposal.cleaner_id);

  return homeId;
}

/**
 * @param {object} params
 * @param {string} params.householdId
 * @param {string} params.homeownerId
 * @param {string} params.cleanerId
 * @param {string | null} params.acceptedProposalId
 * @param {'byoc' | 'match'} params.source
 * @param {object} terms
 */
export function createAgreement({
  householdId,
  homeownerId,
  cleanerId,
  acceptedProposalId = null,
  source,
  terms,
}) {
  if (source === 'match' && !acceptedProposalId) {
    throw new ServiceError('Match agreements require an accepted proposal');
  }
  if (source === 'byoc' && acceptedProposalId) {
    throw new ServiceError('BYOC agreements must not reference a marketplace proposal');
  }

  const existing = db
    .prepare(
      `SELECT id FROM household_cleaner_agreements
       WHERE household_id = ? AND cleaner_id = ? AND status = 'active'`
    )
    .get(householdId, cleanerId);
  if (existing) {
    throw new ServiceError('An active agreement already exists for this cleaner', { status: 409 });
  }

  const id = uuid();
  db.prepare(
    `INSERT INTO household_cleaner_agreements (
      id, household_id, homeowner_id, cleaner_id, accepted_proposal_id, source,
      hourly_rate_cents, recurring_estimated_minutes, recurring_estimated_total_cents,
      first_visit_estimated_minutes, first_visit_estimated_total_cents,
      agreed_frequency, agreed_day, agreed_start_time, agreed_end_time,
      supplies_included, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
  ).run(
    id,
    householdId,
    homeownerId,
    cleanerId,
    acceptedProposalId,
    source,
    terms.hourly_rate_cents,
    terms.recurring_estimated_minutes,
    terms.recurring_estimated_total_cents,
    terms.first_visit_estimated_minutes,
    terms.first_visit_estimated_total_cents,
    terms.agreed_frequency,
    terms.agreed_day,
    terms.agreed_start_time,
    terms.agreed_end_time,
    terms.supplies_included ? 1 : 0
  );

  return getAgreementById(id);
}

/**
 * BYOC: create agreement when cleaner joins via invite (no proposal).
 * Call from route handler after successful /invites/join if desired.
 *
 * @param {{ homeId: string, cleanerId: string, homeownerId?: string }} params
 */
export function createByocAgreement({ homeId, cleanerId, homeownerId }) {
  const home = db.prepare('SELECT * FROM homes WHERE id = ?').get(homeId);
  assertFound(home, 'Household not found');
  const ownerId = homeownerId || home.owner_id;

  const hourlyRate = home.hourly_rate_cents ?? 0;
  const templates = db
    .prepare(
      `SELECT tt.estimated_minutes FROM task_templates tt
       JOIN rooms r ON r.id = tt.room_id
       WHERE r.home_id = ? AND tt.active = 1`
    )
    .all(homeId);
  const minutes = templates.reduce((s, t) => s + (t.estimated_minutes || 15), 0) || 120;
  const costCents = hourlyRate ? Math.round((minutes * hourlyRate) / 60) : 0;

  connectCleanerToHousehold(homeId, cleanerId);

  return createAgreement({
    householdId: homeId,
    homeownerId: ownerId,
    cleanerId,
    acceptedProposalId: null,
    source: 'byoc',
    terms: {
      hourly_rate_cents: hourlyRate,
      recurring_estimated_minutes: minutes,
      recurring_estimated_total_cents: costCents,
      first_visit_estimated_minutes: minutes,
      first_visit_estimated_total_cents: costCents,
      agreed_frequency: 'weekly',
      agreed_day: home.visit_day,
      agreed_start_time: home.visit_time,
      agreed_end_time: null,
      supplies_included: false,
    },
  });
}

/**
 * Accept proposal → household + agreement (source: match).
 * @param {string} proposalId
 * @param {string} homeownerId
 */
export function createFromAcceptedProposal(proposalId, homeownerId) {
  const proposal = db.prepare('SELECT * FROM cleaner_proposals WHERE id = ?').get(proposalId);
  assertFound(proposal, 'Proposal not found');

  const request = db.prepare('SELECT * FROM cleaning_requests WHERE id = ?').get(proposal.request_id);
  assertFound(request, 'Cleaning request not found');

  if (request.homeowner_id !== homeownerId) {
    throw new ServiceError('Not allowed', { status: 403 });
  }

  if (!['sent', 'viewed'].includes(proposal.status)) {
    throw new ServiceError('This proposal cannot be accepted');
  }

  if (!['open', 'proposals_received'].includes(request.status)) {
    throw new ServiceError('This request is no longer accepting a proposal');
  }

  const accept = db.transaction(() => {
    db.prepare(
      `UPDATE cleaner_proposals SET status = 'accepted', updated_at = datetime('now') WHERE id = ?`
    ).run(proposalId);

    db.prepare(
      `UPDATE cleaner_proposals SET status = 'declined', updated_at = datetime('now')
       WHERE request_id = ? AND id != ? AND status IN ('sent', 'viewed')`
    ).run(request.id, proposalId);

    const homeId = request.household_id || createHouseholdFromMatch(homeownerId, request, proposal);

    if (request.household_id && request.household_id !== homeId) {
      connectCleanerToHousehold(request.household_id, proposal.cleaner_id);
    }

    db.prepare(
      `UPDATE cleaning_requests SET household_id = ?, status = 'proposal_accepted',
       updated_at = datetime('now') WHERE id = ?`
    ).run(homeId, request.id);

    const tasks = db
      .prepare('SELECT * FROM cleaning_request_tasks WHERE request_id = ?')
      .all(request.id);
    const scopeSummary = buildScopeSummary(tasks);

    const agreement = createAgreement({
      householdId: homeId,
      homeownerId,
      cleanerId: proposal.cleaner_id,
      acceptedProposalId: proposalId,
      source: 'match',
      terms: {
        hourly_rate_cents: proposal.hourly_rate_cents,
        recurring_estimated_minutes: proposal.recurring_estimated_minutes,
        recurring_estimated_total_cents: proposal.recurring_total_cents,
        first_visit_estimated_minutes: proposal.first_visit_estimated_minutes,
        first_visit_estimated_total_cents: proposal.first_visit_total_cents,
        agreed_frequency: request.frequency,
        agreed_day: proposal.proposed_day,
        agreed_start_time: proposal.proposed_start_time,
        agreed_end_time: proposal.proposed_end_time,
        supplies_included: !!proposal.supplies_included,
      },
    });

    db.prepare(
      `UPDATE cleaning_requests SET status = 'converted', updated_at = datetime('now') WHERE id = ?`
    ).run(request.id);

    return { agreement, scopeSummary, homeId };
  });

  const result = accept();
  const formatted = result.agreement;
  formatted.scope_summary = result.scopeSummary;
  formatted.request_id = request.id;
  return formatted;
}

/**
 * @param {string} agreementId
 */
export function getAgreementById(agreementId) {
  const row = db
    .prepare('SELECT * FROM household_cleaner_agreements WHERE id = ?')
    .get(agreementId);
  assertFound(row, 'Agreement not found');

  const cleaner = db.prepare('SELECT display_name FROM users WHERE id = ?').get(row.cleaner_id);
  let requestId = null;
  let scopeSummary = '';

  if (row.accepted_proposal_id) {
    const proposal = db
      .prepare('SELECT request_id FROM cleaner_proposals WHERE id = ?')
      .get(row.accepted_proposal_id);
    requestId = proposal?.request_id ?? null;
    if (requestId) {
      const tasks = db
        .prepare('SELECT * FROM cleaning_request_tasks WHERE request_id = ?')
        .all(requestId);
      scopeSummary = buildScopeSummary(tasks);
    }
  }

  const formatted = formatAgreementRow(row, { cleanerName: cleaner?.display_name });
  formatted.request_id = requestId;
  formatted.scope_summary = scopeSummary || formatted.scope_summary;
  return formatted;
}

/**
 * @param {string} userId
 * @param {'client' | 'cleaner'} role
 */
export function listAgreementsForUser(userId, role) {
  let rows;
  if (role === 'client') {
    rows = db
      .prepare(
        `SELECT * FROM household_cleaner_agreements WHERE homeowner_id = ? ORDER BY created_at DESC`
      )
      .all(userId);
  } else {
    rows = db
      .prepare(
        `SELECT * FROM household_cleaner_agreements WHERE cleaner_id = ? ORDER BY created_at DESC`
      )
      .all(userId);
  }

  return rows.map((row) => {
    const cleaner = db.prepare('SELECT display_name FROM users WHERE id = ?').get(row.cleaner_id);
    return formatAgreementRow(row, { cleanerName: cleaner?.display_name });
  });
}

/**
 * Verify user can read agreement.
 * @param {string} agreementId
 * @param {string} userId
 */
export function getAgreementForUser(agreementId, userId) {
  const row = db
    .prepare('SELECT * FROM household_cleaner_agreements WHERE id = ?')
    .get(agreementId);
  assertFound(row, 'Agreement not found');

  const allowed =
    row.homeowner_id === userId ||
    row.cleaner_id === userId ||
    db
      .prepare(
        `SELECT 1 FROM home_members WHERE home_id = ? AND user_id = ? AND role IN ('owner', 'member')`
      )
      .get(row.household_id, userId);

  if (!allowed) {
    throw new ServiceError('Not allowed', { status: 403 });
  }

  return getAgreementById(agreementId);
}
