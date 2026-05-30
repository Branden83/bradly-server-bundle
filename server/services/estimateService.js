/**
 * Centralized visit minute and cost calculations.
 * Applies hourly rate, then enforces minimum visit charge when configured.
 */

/**
 * @param {Array<{ estimated_minutes?: number }>} tasks
 * @returns {number}
 */
export function sumTaskMinutes(tasks) {
  if (!tasks?.length) return 0;
  return tasks.reduce((sum, t) => sum + (Number(t.estimated_minutes) || 0), 0);
}

/**
 * @param {number} minutes
 * @param {number} hourlyRateCents
 * @param {number | null} [minimumVisitMinutes]
 * @param {number | null} [minimumVisitCents]
 * @returns {number}
 */
export function calcVisitTotalCents(
  minutes,
  hourlyRateCents,
  minimumVisitMinutes = null,
  minimumVisitCents = null
) {
  const { costCents } = calculateVisitEstimate(minutes, hourlyRateCents, {
    minimumVisitMinutes,
    minimumVisitCents,
  });
  return costCents;
}

/**
 * @param {number} minutes
 * @param {number} hourlyRateCents
 * @param {{ minimumVisitMinutes?: number | null, minimumVisitCents?: number | null }} [opts]
 * @returns {{ minutes: number, costCents: number }}
 */
export function calculateVisitEstimate(minutes, hourlyRateCents, opts = {}) {
  const mins = Math.max(0, Math.round(minutes));
  const rate = Math.max(0, hourlyRateCents);
  let costCents = rate > 0 ? Math.round((mins * rate) / 60) : 0;

  const minMinutes = opts.minimumVisitMinutes ?? null;
  const minCents = opts.minimumVisitCents ?? null;

  if (minMinutes != null && mins < minMinutes && minCents != null) {
    costCents = Math.max(costCents, minCents);
  } else if (minCents != null && costCents < minCents) {
    costCents = minCents;
  }

  return { minutes: mins, costCents };
}

/**
 * First and recurring visit estimates are calculated separately.
 *
 * @param {{
 *   hourlyRateCents: number,
 *   firstVisitMinutes: number,
 *   recurringVisitMinutes: number,
 *   minimumVisitMinutes?: number | null,
 *   minimumVisitCents?: number | null,
 * }} params
 */
export function calculateProposalEstimates({
  hourlyRateCents,
  firstVisitMinutes,
  recurringVisitMinutes,
  minimumVisitMinutes = null,
  minimumVisitCents = null,
}) {
  const first = calculateVisitEstimate(firstVisitMinutes, hourlyRateCents, {
    minimumVisitMinutes,
    minimumVisitCents,
  });
  const recurring = calculateVisitEstimate(recurringVisitMinutes, hourlyRateCents, {
    minimumVisitMinutes,
    minimumVisitCents,
  });

  return {
    first_visit_estimated_minutes: first.minutes,
    first_visit_total_cents: first.costCents,
    recurring_estimated_minutes: recurring.minutes,
    recurring_total_cents: recurring.costCents,
  };
}

/**
 * @param {number} dayOfWeek
 * @param {string} startTime
 * @param {string} [endTime]
 */
export function formatAvailabilityNote(dayOfWeek, startTime, endTime) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const day = days[dayOfWeek] ?? 'Day';
  if (endTime) return `${day}s ${startTime}–${endTime}`;
  return `${day}s from ${startTime}`;
}

/**
 * Legacy visit checklist estimate (task_templates on visits).
 * @param {import('better-sqlite3').Database} database
 * @param {string} visitId
 * @param {number | null} hourlyRateCents
 */
export function computeVisitEstimatesFromDb(database, visitId, hourlyRateCents) {
  const row = database
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(tt.estimated_minutes, 15)), 0) as total
       FROM visit_tasks vt
       LEFT JOIN task_templates tt ON tt.id = vt.task_template_id
       WHERE vt.visit_id = ?`
    )
    .get(visitId);
  const totalEstimatedMinutes = row?.total ?? 0;
  const { costCents } = calculateVisitEstimate(
    totalEstimatedMinutes,
    hourlyRateCents ?? 0
  );
  return {
    totalEstimatedMinutes,
    estimatedCostCents: hourlyRateCents != null ? costCents : null,
    hourlyRateCents: hourlyRateCents ?? null,
  };
}
