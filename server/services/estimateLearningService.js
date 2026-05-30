import { v4 as uuid } from 'uuid';
import OpenAI from 'openai';
import { getOpenAiApiKey, REMINDER_MODEL } from '../ai/reminders.js';
import db from '../db.js';
import { assertFound, ServiceError } from '../lib/serviceError.js';

/**
 * Estimate learning policy:
 * - Rules-first: median of last N actuals per task_template (MIN_SAMPLES=3).
 * - Suggest when divergence >15% AND delta >=3 min (MIN_DELTA_PERCENT / MIN_DELTA_MINUTES).
 * - Default: queue suggestions for homeowner review — no silent template changes.
 * - Optional auto-apply: app_settings.estimate_learning_auto_apply=true caps each change at 20%.
 * - OpenAI summaries cached 7 days; local template fallback when key missing or call fails.
 * - Protected traits are never used as inputs.
 */

const AI_SUMMARY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const LEARNING_CONFIG = {
  LAST_N: 10,
  MIN_SAMPLES: 3,
  MIN_DELTA_MINUTES: 3,
  /** Suggest only when median actuals diverge >15% from template estimate. */
  MIN_DELTA_PERCENT: 0.15,
  /** When auto-apply is enabled via app_settings, cap each update at 20%. */
  AUTO_APPLY_MAX_DELTA_PERCENT: 0.2,
  ROUND_TO_MINUTES: 5,
};

/**
 * @param {number[]} values
 * @returns {number | null}
 */
export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * @param {number} value
 * @param {number} step
 */
export function roundToNearest(value, step = LEARNING_CONFIG.ROUND_TO_MINUTES) {
  return Math.max(step, Math.round(value / step) * step);
}

/**
 * @param {import('better-sqlite3').Database} database
 */
function isAutoApplyEnabled(database) {
  const row = database.prepare('SELECT value FROM app_settings WHERE key = ?').get(
    'estimate_learning_auto_apply'
  );
  return row?.value === '1' || row?.value === 'true';
}

export const MIN_SAMPLES = LEARNING_CONFIG.MIN_SAMPLES;

/** @deprecated alias for tests */
export function medianMinutes(values) {
  return median(values);
}

/**
 * @param {number} currentMinutes
 * @param {number} suggestedMinutes
 */
export function divergenceFraction(currentMinutes, suggestedMinutes) {
  if (!currentMinutes) return 1;
  return Math.abs(suggestedMinutes - currentMinutes) / currentMinutes;
}

/**
 * Cap a suggested estimate change (default 20%) for auto-apply safety.
 * @param {number} currentMinutes
 * @param {number} suggestedMinutes
 * @param {number} [maxFraction]
 */
export function capEstimateChange(
  currentMinutes,
  suggestedMinutes,
  maxFraction = LEARNING_CONFIG.AUTO_APPLY_MAX_DELTA_PERCENT
) {
  const delta = suggestedMinutes - currentMinutes;
  const maxDelta = Math.max(1, Math.ceil(currentMinutes * maxFraction));
  if (Math.abs(delta) <= maxDelta) return suggestedMinutes;
  return delta > 0 ? currentMinutes + maxDelta : currentMinutes - maxDelta;
}

/**
 * Rules-first median suggestion from recent actual samples.
 * @param {number} currentMinutes
 * @param {Array<{ actual_minutes: number }>} samples
 */
export function computeSuggestionFromSamples(currentMinutes, samples) {
  if (!samples?.length || samples.length < LEARNING_CONFIG.MIN_SAMPLES) return null;

  const actuals = samples.map((s) => s.actual_minutes);
  const suggestedMinutes = median(actuals);
  if (suggestedMinutes == null) return null;

  const divergence = divergenceFraction(currentMinutes, suggestedMinutes);
  if (divergence < LEARNING_CONFIG.MIN_DELTA_PERCENT) return null;

  return {
    suggestedMinutes,
    sampleCount: samples.length,
    divergencePercent: divergence,
  };
}

/**
 * Backfill actual_minutes on done tasks that have started_at but no recorded duration.
 * @param {import('better-sqlite3').Database} database
 * @param {string} visitId
 */
export function inferActualMinutesForVisit(database, visitId) {
  const tasks = database
    .prepare(
      `SELECT id, started_at, completed_at
       FROM visit_tasks
       WHERE visit_id = ? AND status = 'done'
         AND actual_minutes IS NULL AND started_at IS NOT NULL`
    )
    .all(visitId);

  const update = database.prepare(`UPDATE visit_tasks SET actual_minutes = ? WHERE id = ?`);
  for (const task of tasks) {
    const completedAt = task.completed_at || new Date().toISOString();
    const startedMs = new Date(task.started_at).getTime();
    const completedMs = new Date(completedAt).getTime();
    const minutes = Math.max(1, Math.ceil((completedMs - startedMs) / 60000));
    update.run(minutes, task.id);
  }
}

/**
 * @param {import('better-sqlite3').Database} database
 * @param {string} templateId
 */
function fetchRecentActualSamples(database, templateId, homeId = null) {
  const fromRecords = database
    .prepare(
      `SELECT actual_minutes
       FROM task_actual_records
       WHERE task_template_id = ?
       ORDER BY recorded_at DESC
       LIMIT ?`
    )
    .all(templateId, LEARNING_CONFIG.LAST_N);

  if (fromRecords.length >= LEARNING_CONFIG.MIN_SAMPLES) {
    return fromRecords;
  }

  if (!homeId) {
    const row = database
      .prepare(
        `SELECT r.home_id FROM task_templates tt JOIN rooms r ON r.id = tt.room_id WHERE tt.id = ?`
      )
      .get(templateId);
    homeId = row?.home_id;
  }

  if (!homeId) return fromRecords;

  return database
    .prepare(
      `SELECT vt.actual_minutes
       FROM visit_tasks vt
       JOIN visits v ON v.id = vt.visit_id
       WHERE vt.task_template_id = ? AND v.home_id = ?
         AND vt.status = 'done' AND vt.actual_minutes IS NOT NULL
       ORDER BY vt.completed_at DESC
       LIMIT ?`
    )
    .all(templateId, homeId, LEARNING_CONFIG.LAST_N);
}

/**
 * Recompute pending estimate suggestions for all active templates in a home.
 * @param {{ db: import('better-sqlite3').Database, homeId: string, getSetting?: (key: string) => string, uuid?: () => string }}
 */
export async function refreshEstimateSuggestionsForHome({
  db: database,
  homeId,
  getSetting,
  uuid: uuidFn = uuid,
}) {
  const templates = database
    .prepare(
      `SELECT tt.id, tt.estimated_minutes, tt.title
       FROM task_templates tt
       JOIN rooms r ON r.id = tt.room_id
       WHERE r.home_id = ? AND tt.active = 1`
    )
    .all(homeId);

  const results = [];
  const upsert = database.prepare(
    `INSERT INTO task_estimate_suggestions (
      id, home_id, task_template_id, current_minutes, suggested_minutes,
      sample_count, divergence_percent, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
    ON CONFLICT(home_id, task_template_id) DO UPDATE SET
      current_minutes = excluded.current_minutes,
      suggested_minutes = excluded.suggested_minutes,
      sample_count = excluded.sample_count,
      divergence_percent = excluded.divergence_percent,
      status = 'pending',
      created_at = datetime('now'),
      applied_at = NULL`
  );

  for (const tpl of templates) {
    const samples = fetchRecentActualSamples(database, tpl.id, homeId);
    const computed = computeSuggestionFromSamples(tpl.estimated_minutes, samples);
    if (!computed) continue;

    upsert.run(
      uuidFn(),
      homeId,
      tpl.id,
      tpl.estimated_minutes,
      computed.suggestedMinutes,
      computed.sampleCount,
      computed.divergencePercent
    );

    const row = database
      .prepare(
        `SELECT s.*, tt.title, r.name AS room_name
         FROM task_estimate_suggestions s
         JOIN task_templates tt ON tt.id = s.task_template_id
         JOIN rooms r ON r.id = tt.room_id
         WHERE s.home_id = ? AND s.task_template_id = ? AND s.status = 'pending'`
      )
      .get(homeId, tpl.id);
    if (row) results.push(formatEstimateSuggestion(row));
  }

  if (getSetting) {
    await refreshAiSummariesForHome(homeId, getSetting, database);
  }

  return results;
}

/**
 * @param {string} taskTemplateId
 * @param {number} actualMinutes
 * @param {import('better-sqlite3').Database} [database]
 * @param {{ visitTaskId?: string, homeId?: string }} [meta]
 */
export function recordActualForTemplate(
  taskTemplateId,
  actualMinutes,
  database = db,
  meta = {}
) {
  const minutes = Math.max(1, Math.round(actualMinutes));
  const template = database.prepare('SELECT id FROM task_templates WHERE id = ?').get(taskTemplateId);
  assertFound(template, 'Task template not found');

  let homeId = meta.homeId;
  if (!homeId) {
    const row = database
      .prepare(
        `SELECT r.home_id
         FROM task_templates tt
         JOIN rooms r ON r.id = tt.room_id
         WHERE tt.id = ?`
      )
      .get(taskTemplateId);
    homeId = row?.home_id;
  }
  assertFound(homeId, 'Home not found for template');

  const id = uuid();
  database
    .prepare(
      `INSERT INTO task_actual_records (id, task_template_id, visit_task_id, home_id, actual_minutes)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(id, taskTemplateId, meta.visitTaskId ?? null, homeId, minutes);

  return database.prepare('SELECT * FROM task_actual_records WHERE id = ?').get(id);
}

/**
 * Rules-first suggestion from recent actuals (median of last N).
 * @param {string} templateId
 * @param {import('better-sqlite3').Database} [database]
 */
export function suggestUpdatedEstimate(templateId, database = db) {
  const template = database.prepare('SELECT * FROM task_templates WHERE id = ?').get(templateId);
  assertFound(template, 'Task template not found');

  const homeRow = database
    .prepare(`SELECT r.home_id FROM task_templates tt JOIN rooms r ON r.id = tt.room_id WHERE tt.id = ?`)
    .get(templateId);

  const rows = fetchRecentActualSamples(database, templateId, homeRow?.home_id);

  const sampleCount = rows.length;
  if (sampleCount < LEARNING_CONFIG.MIN_SAMPLES) {
    return {
      templateId,
      currentMinutes: template.estimated_minutes,
      suggestedMinutes: null,
      sampleCount,
      reason: 'insufficient_samples',
      shouldUpdate: false,
    };
  }

  const actuals = rows.map((r) => r.actual_minutes);
  const rawSuggested = median(actuals);
  const suggestedMinutes = roundToNearest(rawSuggested ?? template.estimated_minutes);
  const currentMinutes = template.estimated_minutes;
  const delta = Math.abs(suggestedMinutes - currentMinutes);
  const deltaPercent = currentMinutes > 0 ? delta / currentMinutes : 1;

  const meetsDelta =
    delta >= LEARNING_CONFIG.MIN_DELTA_MINUTES &&
    deltaPercent >= LEARNING_CONFIG.MIN_DELTA_PERCENT;

  return {
    templateId,
    currentMinutes,
    suggestedMinutes,
    sampleCount,
    medianActual: rawSuggested,
    delta,
    deltaPercent,
    shouldUpdate: meetsDelta,
    reason: meetsDelta ? 'ready' : 'delta_too_small',
  };
}

/**
 * Apply estimate update or queue for homeowner review.
 * @param {string} homeId
 * @param {string} templateId
 * @param {number} newMinutes
 * @param {{ auto?: boolean, database?: import('better-sqlite3').Database, sampleCount?: number }} [opts]
 */
export function applyEstimateUpdate(homeId, templateId, newMinutes, opts = {}) {
  const database = opts.database ?? db;
  const auto = opts.auto ?? false;

  const row = database
    .prepare(
      `SELECT tt.*, r.home_id
       FROM task_templates tt
       JOIN rooms r ON r.id = tt.room_id
       WHERE tt.id = ?`
    )
    .get(templateId);
  assertFound(row, 'Task template not found');
  if (row.home_id !== homeId) {
    throw new ServiceError('Template does not belong to this home', { status: 403 });
  }

  const minutes = Math.max(1, Math.round(newMinutes));
  const currentMinutes = row.estimated_minutes;

  if (minutes === currentMinutes) {
    return { applied: false, reviewQueued: false, currentMinutes, newMinutes: minutes };
  }

  const deltaPercent =
    currentMinutes > 0 ? Math.abs(minutes - currentMinutes) / currentMinutes : 1;
  const canAutoApply =
    auto &&
    isAutoApplyEnabled(database) &&
    deltaPercent <= LEARNING_CONFIG.AUTO_APPLY_MAX_DELTA_PERCENT;

  if (canAutoApply) {
    database
      .prepare(`UPDATE task_templates SET estimated_minutes = ? WHERE id = ?`)
      .run(minutes, templateId);

    database
      .prepare(
        `UPDATE task_estimate_suggestions
         SET status = 'dismissed'
         WHERE home_id = ? AND task_template_id = ? AND status = 'pending'`
      )
      .run(homeId, templateId);

    return {
      applied: true,
      reviewQueued: false,
      currentMinutes,
      newMinutes: minutes,
      mode: 'auto',
    };
  }

  const existingPending = database
    .prepare(
      `SELECT id FROM task_estimate_suggestions
       WHERE home_id = ? AND task_template_id = ? AND status = 'pending'
       LIMIT 1`
    )
    .get(homeId, templateId);

  if (existingPending) {
    database
      .prepare(
        `UPDATE task_estimate_suggestions
         SET current_minutes = ?, suggested_minutes = ?, sample_count = ?,
             divergence_percent = ?, created_at = datetime('now')
         WHERE id = ?`
      )
      .run(
        currentMinutes,
        minutes,
        opts.sampleCount ?? 0,
        deltaPercent,
        existingPending.id
      );
  } else {
    database
      .prepare(
        `INSERT INTO task_estimate_suggestions (
          id, home_id, task_template_id, current_minutes, suggested_minutes,
          sample_count, divergence_percent, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
      )
      .run(
        uuid(),
        homeId,
        templateId,
        currentMinutes,
        minutes,
        opts.sampleCount ?? 0,
        deltaPercent
      );
  }

  return {
    applied: false,
    reviewQueued: true,
    currentMinutes,
    newMinutes: minutes,
    mode: 'review',
  };
}

/**
 * Record actual and evaluate estimate update for one completed task.
 * @param {{ homeId: string, taskTemplateId: string, visitTaskId: string, actualMinutes: number, database?: import('better-sqlite3').Database }}
 */
export function processTaskActual({
  homeId,
  taskTemplateId,
  visitTaskId,
  actualMinutes,
  database = db,
}) {
  recordActualForTemplate(taskTemplateId, actualMinutes, database, { visitTaskId, homeId });

  const suggestion = suggestUpdatedEstimate(taskTemplateId, database);
  if (!suggestion.shouldUpdate || suggestion.suggestedMinutes == null) {
    return { suggestion, update: null };
  }

  const update = applyEstimateUpdate(homeId, taskTemplateId, suggestion.suggestedMinutes, {
    auto: true,
    database,
    sampleCount: suggestion.sampleCount,
  });

  return { suggestion, update };
}

/**
 * On visit completion, process any timed tasks not yet fed to learning.
 * @param {string} visitId
 * @param {string} homeId
 * @param {import('better-sqlite3').Database} [database]
 */
export function processVisitCompletion(visitId, homeId, database = db) {
  const tasks = database
    .prepare(
      `SELECT id, task_template_id, actual_minutes
       FROM visit_tasks
       WHERE visit_id = ? AND status = 'done' AND task_template_id IS NOT NULL AND actual_minutes IS NOT NULL`
    )
    .all(visitId);

  const results = [];
  const seenTemplates = new Set();

  for (const task of tasks) {
    if (seenTemplates.has(task.task_template_id)) continue;

    const alreadyRecorded = database
      .prepare(
        `SELECT 1 FROM task_actual_records WHERE visit_task_id = ? AND task_template_id = ? LIMIT 1`
      )
      .get(task.id, task.task_template_id);
    if (alreadyRecorded) {
      seenTemplates.add(task.task_template_id);
      continue;
    }

    results.push(
      processTaskActual({
        homeId,
        taskTemplateId: task.task_template_id,
        visitTaskId: task.id,
        actualMinutes: task.actual_minutes,
        database,
      })
    );
    seenTemplates.add(task.task_template_id);
  }

  return results;
}

/**
 * @param {object} row
 */
export function formatEstimateSuggestion(row) {
  const divergence =
    row.divergence_percent ??
    (row.current_minutes > 0
      ? Math.abs(row.suggested_minutes - row.current_minutes) / row.current_minutes
      : 0);

  return {
    id: row.id,
    home_id: row.home_id,
    task_template_id: row.task_template_id,
    title: row.title,
    room_name: row.room_name ?? null,
    current_minutes: row.current_minutes,
    suggested_minutes: row.suggested_minutes,
    sample_count: row.sample_count,
    divergence_percent: divergence,
    ai_summary: row.ai_summary ?? null,
    status: row.status,
    label: `Suggested estimate update: ${row.title} ${row.current_minutes}→${row.suggested_minutes} min`,
    home_name: row.home_name ?? null,
  };
}

/**
 * Local fallback when OpenAI is unavailable (mirrors reminders.js pattern).
 */
export function buildLocalEstimateSummary({ taskTitle, suggestedMinutes, sampleCount, homeName }) {
  const place = homeName?.trim() ? ` at ${homeName.trim()}` : ' at this home';
  return `${taskTitle} usually takes about ${suggestedMinutes} min${place} (based on ${sampleCount} recent visits).`;
}

/**
 * @param {string} apiKey
 * @param {{ taskTitle: string; suggestedMinutes: number; sampleCount: number; homeName: string; currentMinutes: number }} ctx
 */
async function summarizeWithAI(apiKey, ctx) {
  const client = new OpenAI({ apiKey });
  const completion = await client.chat.completions.create({
    model: REMINDER_MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Write one short neutral sentence about how long a recurring cleaning task typically takes at a specific home. Never mention protected traits. Return JSON: {"summary":"..."}.',
      },
      {
        role: 'user',
        content: `Home: ${ctx.homeName || 'this home'}
Task: ${ctx.taskTitle}
Current estimate: ${ctx.currentMinutes} min
Median from ${ctx.sampleCount} visits: ${ctx.suggestedMinutes} min`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content || '{}';
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
      return parsed.summary.trim();
    }
  } catch {
    // fall through
  }
  return buildLocalEstimateSummary(ctx);
}

/**
 * Cache AI/local summaries for pending suggestions (not on every page load).
 * @param {string} homeId
 * @param {(key: string) => string} getSetting
 * @param {import('better-sqlite3').Database} [database]
 */
export async function refreshAiSummariesForHome(homeId, getSetting, database = db) {
  const home = database.prepare('SELECT name FROM homes WHERE id = ?').get(homeId);
  const pending = database
    .prepare(
      `SELECT s.*, tt.title
       FROM task_estimate_suggestions s
       JOIN task_templates tt ON tt.id = s.task_template_id
       WHERE s.home_id = ? AND s.status = 'pending'`
    )
    .all(homeId);

  const apiKey = getOpenAiApiKey(getSetting);

  for (const row of pending) {
    const cachedAt = row.ai_summary_cached_at
      ? new Date(row.ai_summary_cached_at).getTime()
      : 0;
    if (row.ai_summary && cachedAt && Date.now() - cachedAt < AI_SUMMARY_TTL_MS) {
      continue;
    }

    const ctx = {
      taskTitle: row.title,
      suggestedMinutes: row.suggested_minutes,
      sampleCount: row.sample_count,
      homeName: home?.name,
      currentMinutes: row.current_minutes,
    };

    let summary;
    try {
      summary = apiKey ? await summarizeWithAI(apiKey, ctx) : buildLocalEstimateSummary(ctx);
    } catch (err) {
      console.error('[estimateLearning] AI summary failed, using local fallback:', err.message);
      summary = buildLocalEstimateSummary(ctx);
    }

    database
      .prepare(
        `UPDATE task_estimate_suggestions
         SET ai_summary = ?, ai_summary_cached_at = datetime('now')
         WHERE id = ?`
      )
      .run(summary, row.id);
  }
}

/**
 * Apply a pending suggestion to task_templates.estimated_minutes.
 * @param {import('better-sqlite3').Database} database
 * @param {string} suggestionId
 */
export function applyEstimateSuggestion(database, suggestionId) {
  const row = database
    .prepare('SELECT * FROM task_estimate_suggestions WHERE id = ?')
    .get(suggestionId);
  if (!row) return null;
  if (row.status !== 'pending') return { error: 'Suggestion is not pending' };

  database
    .prepare('UPDATE task_templates SET estimated_minutes = ? WHERE id = ?')
    .run(row.suggested_minutes, row.task_template_id);

  database
    .prepare(
      `UPDATE task_estimate_suggestions
       SET status = 'applied', current_minutes = ?, applied_at = datetime('now')
       WHERE id = ?`
    )
    .run(row.suggested_minutes, suggestionId);

  return database
    .prepare(
      `SELECT s.*, tt.title, r.name AS room_name
       FROM task_estimate_suggestions s
       JOIN task_templates tt ON tt.id = s.task_template_id
       JOIN rooms r ON r.id = tt.room_id
       WHERE s.id = ?`
    )
    .get(suggestionId);
}

/**
 * @param {string} homeId
 * @param {import('better-sqlite3').Database} [database]
 */
export function listPendingEstimateSuggestions(homeId, database = db) {
  const rows = database
    .prepare(
      `SELECT s.*, tt.title, r.name AS room_name
       FROM task_estimate_suggestions s
       JOIN task_templates tt ON tt.id = s.task_template_id
       JOIN rooms r ON r.id = tt.room_id
       WHERE s.home_id = ? AND s.status = 'pending'
       ORDER BY s.created_at DESC`
    )
    .all(homeId);
  return rows.map(formatEstimateSuggestion);
}
