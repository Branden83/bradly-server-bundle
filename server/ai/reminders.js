import OpenAI from 'openai';
import {
  buildFocusReminders,
  detectRepeatedThemesLocal,
  routeThemesToSkills,
} from './skillTree.js';

export const REMINDER_MODEL = 'gpt-4o-mini';
const CACHE_TTL_MS = 60 * 60 * 1000;

/** @type {Map<string, { reminders: string[]; expiresAt: number }>} */
const reminderCache = new Map();

/**
 * Resolve OpenAI key: env first, then app_settings.openai_api_key (admin UI).
 * Never returned to clients.
 * @param {(key: string) => string} getSetting
 */
export function getOpenAiApiKey(getSetting) {
  const fromEnv = process.env.OPENAI_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  return getSetting('openai_api_key')?.trim() || '';
}

function cacheKey(homeId, visitId) {
  return `${homeId}:${visitId || 'upcoming'}`;
}

function getCached(homeId, visitId) {
  const entry = reminderCache.get(cacheKey(homeId, visitId));
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    reminderCache.delete(cacheKey(homeId, visitId));
    return null;
  }
  return entry.reminders;
}

function setCache(homeId, visitId, reminders) {
  reminderCache.set(cacheKey(homeId, visitId), {
    reminders,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

/**
 * Ask gpt-4o-mini to find improvement themes that recur across feedback entries.
 * @param {string} apiKey
 * @param {{ needs_improvement: string; created_at: string }[]} feedbackRows
 * @returns {Promise<string[]>}
 */
async function detectRepeatedThemesWithAI(apiKey, feedbackRows) {
  const snippets = feedbackRows
    .filter((r) => r.needs_improvement?.trim())
    .map((r, i) => `${i + 1}. (${r.created_at}) ${r.needs_improvement.trim()}`)
    .join('\n');

  if (!snippets) return [];

  const client = new OpenAI({ apiKey });
  const completion = await client.chat.completions.create({
    model: REMINDER_MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You analyze recurring themes in homeowner cleaning feedback to help cleaners understand client preferences. Only flag themes that appear in at least two separate comments or are clearly repeated. Never quote or paraphrase harsh criticism. Return JSON: {"themes":["theme one","theme two"]}. Use short lowercase theme labels (2-4 words). If nothing repeats, return {"themes":[]}.',
      },
      {
        role: 'user',
        content: `Feedback entries (newest first):\n${snippets}`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content || '{}';
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.themes)) {
      return parsed.themes.filter((t) => typeof t === 'string' && t.trim());
    }
  } catch {
    // fall through to local detection
  }
  return detectRepeatedThemesLocal(feedbackRows);
}

/**
 * Generate focus-area reminder strings for a cleaner's upcoming visit.
 * Cached per home+visit for 1 hour to rate-limit OpenAI usage.
 *
 * @param {{ db: import('better-sqlite3').Database; homeId: string; visitId: string; getSetting: (key: string) => string }} opts
 * @returns {Promise<string[]>}
 */
export async function getCleanerReminders({ db, homeId, visitId, getSetting }) {
  const cached = getCached(homeId, visitId);
  if (cached) return cached;

  const feedbackRows = db
    .prepare(
      `SELECT needs_improvement, created_at FROM visit_feedback
       WHERE home_id = ? AND trim(needs_improvement) != ''
       ORDER BY created_at DESC
       LIMIT 24`
    )
    .all(homeId);

  if (feedbackRows.length === 0) {
    setCache(homeId, visitId, []);
    return [];
  }

  const apiKey = getOpenAiApiKey(getSetting);
  let themes;

  try {
    if (apiKey) {
      themes = await detectRepeatedThemesWithAI(apiKey, feedbackRows);
    } else {
      themes = detectRepeatedThemesLocal(feedbackRows);
    }
  } catch (err) {
    console.error('[reminders] AI theme detection failed, using local fallback:', err.message);
    themes = detectRepeatedThemesLocal(feedbackRows);
  }

  const skills = routeThemesToSkills(themes);
  const reminders = buildFocusReminders(skills);

  setCache(homeId, visitId, reminders);
  return reminders;
}

/** Test helper — clear in-memory cache. */
export function clearReminderCache() {
  reminderCache.clear();
}
