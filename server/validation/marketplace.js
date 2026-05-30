import { ServiceError } from '../lib/serviceError.js';

const PROFILE_STATUSES = new Set([
  'draft',
  'pending_review',
  'approved',
  'rejected',
  'suspended',
]);
const REQUEST_STATUSES = new Set([
  'draft',
  'open',
  'proposals_received',
  'proposal_accepted',
  'cancelled',
  'converted',
]);
const PROPOSAL_STATUSES = new Set(['sent', 'viewed', 'accepted', 'declined', 'withdrawn', 'expired']);
const AGREEMENT_SOURCES = new Set(['byoc', 'match']);
const AGREEMENT_STATUSES = new Set(['active', 'paused', 'ended']);
const FREQUENCIES = new Set(['one_time', 'weekly', 'biweekly', 'monthly']);
const CADENCES = new Set(['weekly', 'monthly', 'quarterly']);

export function requireString(value, field, { min = 1, max = 5000 } = {}) {
  if (typeof value !== 'string' || value.trim().length < min) {
    throw new ServiceError(`${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new ServiceError(`${field} must be at most ${max} characters`);
  }
  return trimmed;
}

export function optionalString(value, field, { max = 5000 } = {}) {
  if (value == null || value === '') return null;
  return requireString(value, field, { min: 1, max });
}

export function requireEnum(value, field, allowed) {
  if (!allowed.has(value)) {
    throw new ServiceError(`Invalid ${field}`);
  }
  return value;
}

export function requirePositiveInt(value, field, { min = 1, max = 100000 } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ServiceError(`Invalid ${field}`);
  }
  return value;
}

export function optionalPositiveInt(value, field, { min = 0, max = 100000 } = {}) {
  if (value == null || value === '') return null;
  return requirePositiveInt(value, field, { min, max });
}

export function requireNonNegativeInt(value, field, { max = 10000000 } = {}) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new ServiceError(`Invalid ${field}`);
  }
  return value;
}

export function requireBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw new ServiceError(`${field} must be true or false`);
  }
  return value;
}

export function optionalBoolean(value) {
  if (value == null) return null;
  return requireBoolean(value, 'value');
}

export function requireZip(value) {
  const zip = requireString(value, 'ZIP code', { min: 5, max: 10 });
  if (!/^\d{5}(-\d{4})?$/.test(zip)) {
    throw new ServiceError('ZIP code must be 5 digits (optional +4 extension)');
  }
  return zip.slice(0, 5);
}

export function requireState(value) {
  const state = requireString(value, 'state', { min: 2, max: 2 }).toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) {
    throw new ServiceError('State must be a 2-letter code');
  }
  return state;
}

export function requireDayOfWeek(value, field = 'day of week') {
  if (!Number.isInteger(value) || value < 0 || value > 6) {
    throw new ServiceError(`Invalid ${field} (0=Sunday through 6=Saturday)`);
  }
  return value;
}

export function requireTime(value, field) {
  const time = requireString(value, field, { min: 4, max: 5 });
  if (!/^\d{1,2}:\d{2}$/.test(time)) {
    throw new ServiceError(`${field} must be in HH:MM format`);
  }
  const [h, m] = time.split(':').map(Number);
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    throw new ServiceError(`Invalid ${field}`);
  }
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function validateProfileStatus(status) {
  return requireEnum(status, 'profile status', PROFILE_STATUSES);
}

export function validateRequestStatus(status) {
  return requireEnum(status, 'request status', REQUEST_STATUSES);
}

export function validateProposalStatus(status) {
  return requireEnum(status, 'proposal status', PROPOSAL_STATUSES);
}

export function validateAgreementSource(source) {
  return requireEnum(source, 'agreement source', AGREEMENT_SOURCES);
}

export function validateAgreementStatus(status) {
  return requireEnum(status, 'agreement status', AGREEMENT_STATUSES);
}

export function validateFrequency(frequency) {
  return requireEnum(frequency, 'frequency', FREQUENCIES);
}

export function validateCadence(cadence) {
  return requireEnum(cadence, 'cadence', CADENCES);
}

export function validateRequestTaskInput(task, index) {
  const label = `task ${index + 1}`;
  const room = requireString(task?.room ?? task?.room_name, `${label} room`);
  const title = requireString(task?.title ?? task?.task_name, `${label} title`);
  const cadence = validateCadence(task?.cadence);
  const estimatedMinutes = requirePositiveInt(
    task?.estimated_minutes ?? task?.estimatedMinutes ?? 15,
    `${label} estimated minutes`,
    { min: 1, max: 480 }
  );
  return {
    room_name: room,
    task_name: title,
    notes: optionalString(task?.notes ?? task?.instructions ?? '', `${label} notes`, { max: 2000 }) || '',
    cadence,
    estimated_minutes: estimatedMinutes,
    is_deep_clean: task?.is_deep_clean || task?.isDeepClean ? 1 : 0,
  };
}

export function validateProposalSendInput(body) {
  const hourlyRateCents = requirePositiveInt(body.hourlyRateCents ?? body.hourly_rate_cents, 'hourly rate', {
    min: 100,
    max: 50000,
  });
  const firstVisitMinutes = requirePositiveInt(
    body.firstVisitEstimatedMinutes ?? body.first_visit_estimated_minutes,
    'first visit estimated minutes',
    { min: 15, max: 960 }
  );
  const recurringVisitMinutes = requirePositiveInt(
    body.recurringEstimatedMinutes ?? body.recurring_estimated_minutes,
    'recurring visit estimated minutes',
    { min: 15, max: 960 }
  );
  const minimumVisitMinutes =
    body.minimumVisitMinutes ?? body.minimum_visit_minutes != null
      ? requirePositiveInt(
          body.minimumVisitMinutes ?? body.minimum_visit_minutes,
          'minimum visit minutes',
          { min: 15, max: 480 }
        )
      : null;
  const minimumVisitCents =
    body.minimumVisitCents ?? body.minimum_visit_cents != null
      ? requireNonNegativeInt(body.minimumVisitCents ?? body.minimum_visit_cents, 'minimum visit charge')
      : null;

  return {
    hourly_rate_cents: hourlyRateCents,
    minimum_visit_minutes: minimumVisitMinutes,
    minimum_visit_cents: minimumVisitCents,
    first_visit_estimated_minutes: firstVisitMinutes,
    recurring_estimated_minutes: recurringVisitMinutes,
    supplies_included: body.suppliesIncluded ?? body.supplies_included ? 1 : 0,
    proposed_day:
      body.proposedDay ?? body.proposed_day != null
        ? requireDayOfWeek(body.proposedDay ?? body.proposed_day)
        : null,
    proposed_start_time:
      body.proposedStartTime ?? body.proposed_start_time
        ? requireTime(body.proposedStartTime ?? body.proposed_start_time, 'proposed start time')
        : null,
    proposed_end_time:
      body.proposedEndTime ?? body.proposed_end_time
        ? requireTime(body.proposedEndTime ?? body.proposed_end_time, 'proposed end time')
        : null,
    message: optionalString(body.message, 'message', { max: 2000 }),
    adjustment_reason: optionalString(body.adjustmentReason ?? body.adjustment_reason, 'adjustment reason', {
      max: 2000,
    }),
  };
}

export {
  PROFILE_STATUSES,
  REQUEST_STATUSES,
  PROPOSAL_STATUSES,
  AGREEMENT_SOURCES,
  FREQUENCIES,
  CADENCES,
};
