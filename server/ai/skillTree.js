/**
 * Skill Tree Router
 *
 * Architecture:
 *   visit_feedback (needs_improvement) → AI/local theme detection → skillTree router → focus reminders
 *
 * The skill tree is a flat map of performance skills (not a deep RPG tree). Each skill node
 * bundles related improvement themes with actionable reminders cleaners see before a visit.
 *
 * Flow:
 *   1. reminders.js collects historical needs_improvement text for a home
 *   2. Repeated themes are extracted (OpenAI or local keyword clustering)
 *   3. routeThemesToSkills() scores each skill against those themes
 *   4. buildFocusReminders() returns 1–4 short strings for the upcoming visit UI
 */

/** @typedef {{ id: string; label: string; themePatterns: RegExp[]; reminders: string[] }} SkillNode */

/** @type {Record<string, SkillNode>} */
export const SKILL_TREE = {
  thoroughness: {
    id: 'thoroughness',
    label: 'Thoroughness',
    themePatterns: [
      /\b(miss(ed|ing)?|forgot|incomplete|half.?done|skipped|overlook)\b/i,
      /\b(detail|corner|edge|spot|crumb|dust|hair|streak|smear|film)\b/i,
      /\b(under|behind|inside|drawer|cabinet|baseboard|blind|vent)\b/i,
      /\b(thorough|deep.?clean|touch.?up)\b/i,
    ],
    reminders: [
      'Slow down in each room — check corners, edges, and hidden spots before moving on.',
      'Use a top-to-bottom, back-to-front pattern so nothing gets missed.',
      'Re-walk each room once before leaving to catch anything you skipped.',
    ],
  },
  communication: {
    id: 'communication',
    label: 'Communication',
    themePatterns: [
      /\b(communicat(e|ion|ing)?|respond|reply|answer|text|call|message)\b/i,
      /\b(update|let.?me.?know|heads.?up|confirm|check.?in)\b/i,
      /\b(unprofessional|rude|attitude|ignore)\b/i,
    ],
    reminders: [
      'Send a quick check-in when you arrive and before you leave.',
      'Reply to client questions the same day — even a short update helps.',
      'Flag anything blocked or skipped so the client is not surprised.',
    ],
  },
  punctuality: {
    id: 'punctuality',
    label: 'Punctuality',
    themePatterns: [
      /\b(late|on.?time|punctual|schedule|window|no.?show|cancel)\b/i,
      /\b(wait(ed|ing)?|delay|behind|early|reschedul)\b/i,
    ],
    reminders: [
      'Plan to arrive a few minutes early — clients notice consistency.',
      'If you will be late, message the client as soon as you know.',
    ],
  },
  organization: {
    id: 'organization',
    label: 'Organization',
    themePatterns: [
      /\b(organiz(e|ation|ing)?|tidy|neat|put.?away|clutter|mess)\b/i,
      /\b(straighten|align|fold|stack|sort|reset)\b/i,
      /\b(pillow|towel|bed|counter|surface)\b/i,
    ],
    reminders: [
      'Reset surfaces — straighten pillows, fold towels, and align items neatly.',
      'Put things back where you found them; do not leave items out of place.',
    ],
  },
  product_care: {
    id: 'product_care',
    label: 'Product & surface care',
    themePatterns: [
      /\b(scratch|damage|break|chip|stain|mark|ruin|wrong.?product)\b/i,
      /\b(wood|marble|granite|stainless|delicate|fragile|handle)\b/i,
      /\b(chemical|bleach|harsh|smell|residue)\b/i,
    ],
    reminders: [
      'Match cleaning products to the surface — when unsure, ask before using something new.',
      'Test unfamiliar products in a hidden spot first.',
    ],
  },
  consistency: {
    id: 'consistency',
    label: 'Consistency',
    themePatterns: [
      /\b(inconsistent|different|varies|sometimes|usually|always|never)\b/i,
      /\b(standard|same|quality|sloppy|rushed|careless)\b/i,
    ],
    reminders: [
      'Follow the same checklist every visit so quality stays predictable.',
      'Do not rush the last rooms — finish with the same attention you started with.',
    ],
  },
};

/** Maps AI theme labels to skill ids for explicit routing. */
const THEME_ALIASES = {
  'attention to detail': 'thoroughness',
  'missed areas': 'thoroughness',
  'missed spots': 'thoroughness',
  'cleaning quality': 'thoroughness',
  'deep cleaning': 'thoroughness',
  communication: 'communication',
  responsiveness: 'communication',
  updates: 'communication',
  punctuality: 'punctuality',
  lateness: 'punctuality',
  scheduling: 'punctuality',
  organization: 'organization',
  tidiness: 'organization',
  'product use': 'product_care',
  'surface damage': 'product_care',
  consistency: 'consistency',
  quality: 'consistency',
};

/**
 * Score skills against detected theme strings and return ranked skill nodes.
 * @param {string[]} themes
 * @returns {SkillNode[]}
 */
export function routeThemesToSkills(themes) {
  if (!themes?.length) return [];

  const scores = new Map();

  for (const rawTheme of themes) {
    const theme = rawTheme.trim().toLowerCase();
    if (!theme) continue;

    if (SKILL_TREE[theme]) {
      scores.set(theme, (scores.get(theme) || 0) + 4);
      continue;
    }

    const aliasSkill = THEME_ALIASES[theme];
    if (aliasSkill && SKILL_TREE[aliasSkill]) {
      scores.set(aliasSkill, (scores.get(aliasSkill) || 0) + 3);
    }

    for (const skill of Object.values(SKILL_TREE)) {
      if (skill.label.toLowerCase() === theme) {
        scores.set(skill.id, (scores.get(skill.id) || 0) + 3);
      }
      for (const pattern of skill.themePatterns) {
        if (pattern.test(theme) || pattern.test(rawTheme)) {
          scores.set(skill.id, (scores.get(skill.id) || 0) + 2);
        }
      }
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([id]) => SKILL_TREE[id])
    .filter(Boolean);
}

/**
 * Build short focus reminders from matched skills (one per skill, max 4).
 * @param {SkillNode[]} skills
 * @returns {string[]}
 */
export function buildFocusReminders(skills) {
  const reminders = [];
  const seen = new Set();

  for (const skill of skills) {
    for (const line of skill.reminders) {
      if (seen.has(line)) continue;
      seen.add(line);
      reminders.push(line);
      break;
    }
    if (reminders.length >= 4) break;
  }

  return reminders;
}

/**
 * Local fallback: cluster feedback by skill keywords and return themes mentioned 2+ times.
 * @param {{ needs_improvement: string }[]} feedbackRows
 * @returns {string[]}
 */
export function detectRepeatedThemesLocal(feedbackRows) {
  const skillHits = new Map();

  for (const row of feedbackRows) {
    const text = row.needs_improvement || '';
    if (!text.trim()) continue;

    for (const skill of Object.values(SKILL_TREE)) {
      if (skill.themePatterns.some((p) => p.test(text))) {
        skillHits.set(skill.id, (skillHits.get(skill.id) || 0) + 1);
      }
    }
  }

  return [...skillHits.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([id]) => id);
}
