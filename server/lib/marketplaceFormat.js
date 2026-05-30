/** Map DB request status to mobile-friendly status strings. */
const REQUEST_STATUS_TO_CLIENT = {
  draft: 'submitted',
  open: 'matching',
  proposals_received: 'proposals_ready',
  proposal_accepted: 'accepted',
  converted: 'accepted',
  cancelled: 'expired',
};

const CLIENT_STATUS_TO_DB = {
  submitted: 'draft',
  matching: 'open',
  proposals_ready: 'proposals_received',
  accepted: 'proposal_accepted',
  expired: 'cancelled',
};

export function clientRequestStatus(dbStatus) {
  return REQUEST_STATUS_TO_CLIENT[dbStatus] || dbStatus;
}

export function dbRequestStatusFromClient(clientStatus) {
  return CLIENT_STATUS_TO_DB[clientStatus] || clientStatus;
}

export function formatCleaningRequestRow(row, tasks = []) {
  if (!row) return null;
  let preferredDay = null;
  let preferredTime = null;
  if (row.preferred_days) {
    try {
      const days = JSON.parse(row.preferred_days);
      if (Array.isArray(days) && days.length) preferredDay = days[0];
    } catch {
      const n = Number(row.preferred_days);
      if (!Number.isNaN(n)) preferredDay = n;
    }
  }
  if (row.preferred_time_windows) {
    try {
      const windows = JSON.parse(row.preferred_time_windows);
      if (Array.isArray(windows) && windows.length) preferredTime = windows[0];
    } catch {
      preferredTime = row.preferred_time_windows;
    }
  }

  return {
    id: row.id,
    zip: row.zip_code,
    city: row.city,
    state: row.state,
    home_size_sqft: row.square_feet ?? null,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    frequency: row.frequency,
    preferences: row.ai_preference_summary ?? null,
    preferred_day: preferredDay,
    preferred_time: preferredTime,
    tasks: tasks.map(formatRequestTaskRow),
    total_estimated_minutes: row.estimated_minutes,
    status: clientRequestStatus(row.status),
    created_at: row.created_at,
    homeowner_id: row.homeowner_id,
    household_id: row.household_id ?? null,
  };
}

export function formatRequestTaskRow(task) {
  return {
    id: task.id,
    room: task.room_name,
    title: task.task_name,
    cadence: task.cadence,
    estimated_minutes: task.estimated_minutes,
    notes: task.notes || '',
    is_deep_clean: !!task.is_deep_clean,
    sort_order: task.sort_order ?? 0,
  };
}

export function formatCleanerProfileRow(row, { serviceAreas = [], availability = [] } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    display_name: row.display_name,
    bio: row.bio || '',
    experience_years: row.experience_years ?? 0,
    hourly_rate_cents: row.hourly_rate_cents,
    minimum_visit_minutes: row.minimum_visit_minutes,
    minimum_visit_cents: row.minimum_visit_cents,
    accepts_new_clients: !!row.accepts_new_clients,
    supplies_included: !!row.supplies_included,
    brings_vacuum: !!row.brings_vacuum,
    languages: row.languages || '',
    profile_status: row.profile_status,
    background_check_status: row.background_check_status,
    insurance_status: row.insurance_status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    service_areas: serviceAreas,
    availability,
  };
}

export function formatProposalRow(row, { cleanerName, matchScore, agreementId } = {}) {
  if (!row) return null;
  const minutes =
    row.recurring_estimated_minutes ?? row.first_visit_estimated_minutes ?? 0;
  const cost =
    row.recurring_total_cents ?? row.first_visit_total_cents ?? 0;
  return {
    id: row.id,
    request_id: row.request_id,
    cleaner_id: row.cleaner_id,
    cleaner_profile_id: row.cleaner_profile_id,
    agreement_id: agreementId ?? null,
    cleaner_name: cleanerName || row.cleaner_name || 'Cleaner',
    hourly_rate_cents: row.hourly_rate_cents,
    minimum_visit_minutes: row.minimum_visit_minutes,
    minimum_visit_cents: row.minimum_visit_cents,
    first_visit_estimated_minutes: row.first_visit_estimated_minutes,
    first_visit_total_cents: row.first_visit_total_cents,
    recurring_estimated_minutes: row.recurring_estimated_minutes,
    recurring_total_cents: row.recurring_total_cents,
    estimated_minutes: minutes,
    estimated_cost_cents: cost,
    match_score: matchScore ?? 0,
    supplies_included: !!row.supplies_included,
    proposed_day: row.proposed_day,
    proposed_start_time: row.proposed_start_time,
    proposed_end_time: row.proposed_end_time,
    message: row.message,
    adjustment_reason: row.adjustment_reason,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function formatAgreementRow(row, { cleanerName } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    proposal_id: row.accepted_proposal_id,
    request_id: row.request_id ?? null,
    household_id: row.household_id,
    homeowner_id: row.homeowner_id,
    cleaner_id: row.cleaner_id,
    cleaner_name: cleanerName || 'Cleaner',
    source: row.source,
    scope_summary: row.scope_summary || '',
    hourly_rate_cents: row.hourly_rate_cents,
    recurring_estimated_minutes: row.recurring_estimated_minutes,
    recurring_estimated_total_cents: row.recurring_estimated_total_cents,
    first_visit_estimated_minutes: row.first_visit_estimated_minutes,
    first_visit_estimated_total_cents: row.first_visit_estimated_total_cents,
    frequency: row.agreed_frequency,
    estimated_minutes: row.recurring_estimated_minutes,
    estimated_cost_cents: row.recurring_estimated_total_cents,
    accepted_at: row.created_at,
    status: row.status,
  };
}

/** Public listing for cleaners — no full address. */
export function formatCleaningRequestForCleaner(row, tasks = []) {
  const base = formatCleaningRequestRow(row, tasks);
  if (!base) return null;
  return {
    ...base,
    zip: base.zip,
    city: base.city,
    state: base.state,
    area_label: `${base.city}, ${base.state} ${base.zip}`,
  };
}

export function serializePreferredDay(day) {
  if (day == null) return null;
  return JSON.stringify([day]);
}

export function serializePreferredTime(time) {
  if (!time) return null;
  return JSON.stringify([time]);
}
