/**
 * Skill Tree Router
 *
 * Architecture:
 *   visit_feedback (needs_improvement) → AI/local theme detection → skillTree router → client-preference reminders
 *
 * Reminders are framed as client preferences — never raw criticism — before cleaners see them on a visit.
 */

/** @typedef {{ id: string; label: string; preferencePhrase: string; themePatterns: RegExp[]; reminders: string[] }} SkillNode */

/** @type {Record<string, SkillNode>} */
export const SKILL_TREE = {
  thoroughness: {
    id: 'thoroughness',
    label: 'Thoroughness',
    preferencePhrase: 'values thorough, detailed cleaning',
    themePatterns: [
      /\b(miss(ed|ing)?|forgot|incomplete|half.?done|skipped|overlook)\b/i,
      /\b(detail|corner|edge|spot|crumb|dust|hair|streak|smear|film)\b/i,
      /\b(under|behind|inside|drawer|cabinet|baseboard|blind|vent)\b/i,
      /\b(thorough|deep.?clean|touch.?up)\b/i,
    ],
    reminders: [
      'Consider a quick final walk-through in each room before moving on.',
      'A top-to-bottom, back-to-front pattern can help cover easy-to-miss spots.',
    ],
  },
  communication: {
    id: 'communication',
    label: 'Communication',
    preferencePhrase: 'appreciates proactive updates',
    themePatterns: [
      /\b(communicat(e|ion|ing)?|respond|reply|answer|text|call|message)\b/i,
      /\b(update|let.?me.?know|heads.?up|confirm|check.?in)\b/i,
      /\b(unprofessional|rude|attitude|ignore)\b/i,
    ],
    reminders: [
      'A brief check-in when you arrive and before you leave often goes a long way.',
      'Same-day replies to questions — even short ones — help this client feel in the loop.',
    ],
  },
  punctuality: {
    id: 'punctuality',
    label: 'Punctuality',
    preferencePhrase: 'especially values punctuality',
    themePatterns: [
      /\b(late|on.?time|punctual|schedule|window|no.?show|cancel)\b/i,
      /\b(wait(ed|ing)?|delay|behind|early|reschedul)\b/i,
    ],
    reminders: [
      'Consider confirming timing before the next visit.',
      'If plans change, an early heads-up helps this client adjust their day.',
    ],
  },
  organization: {
    id: 'organization',
    label: 'Organization',
    preferencePhrase: 'likes tidy, reset surfaces',
    themePatterns: [
      /\b(organiz(e|ation|ing)?|tidy|neat|put.?away|clutter|mess)\b/i,
      /\b(straighten|align|fold|stack|sort|reset)\b/i,
      /\b(pillow|towel|bed|counter|surface)\b/i,
    ],
    reminders: [
      'Straightening pillows, folding towels, and resetting surfaces tends to stand out here.',
      'Returning items to where you found them matches how this client likes things left.',
    ],
  },
  product_care: {
    id: 'product_care',
    label: 'Product & surface care',
    preferencePhrase: 'is careful about surfaces and products',
    themePatterns: [
      /\b(scratch|damage|break|chip|stain|mark|ruin|wrong.?product)\b/i,
      /\b(wood|marble|granite|stainless|delicate|fragile|handle)\b/i,
      /\b(chemical|bleach|harsh|smell|residue)\b/i,
    ],
    reminders: [
      'When unsure about a product, a quick ask before trying something new is appreciated.',
      'Testing unfamiliar products in a hidden spot first aligns with this client\'s preferences.',
    ],
  },
  consistency: {
    id: 'consistency',
    label: 'Consistency',
    preferencePhrase: 'values steady, predictable quality',
    themePatterns: [
      /\b(inconsistent|different|varies|sometimes|usually|always|never)\b/i,
      /\b(standard|same|quality|sloppy|rushed|careless)\b/i,
    ],
    reminders: [
      'Following the same checklist each visit helps match what this client expects.',
      'Saving the same attention for the last rooms as the first keeps quality even.',
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
 * Build gentle client-preference reminders from matched skills (max 4).
 * @param {SkillNode[]} skills
 * @returns {string[]}
 */
export function buildFocusReminders(skills) {
  const reminders = [];
  const seen = new Set();

  for (const skill of skills) {
    for (const tip of skill.reminders) {
      const line = `Recent feedback suggests this client ${skill.preferencePhrase}. ${tip}`;
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
