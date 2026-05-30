import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { assertFound, ServiceError } from '../lib/serviceError.js';

/** @typedef {{ zip_code?: string | null, city?: string | null, state?: string | null }} LocationLike */
/** @typedef {{ zip_code?: string | null, city?: string | null, state?: string | null, radius_miles?: number | null }} ServiceAreaLike */

/**
 * Fields that must never influence ranking (compliance).
 * Language is communication-only, not a proxy for national origin or ethnicity.
 */
export const PROTECTED_TRAIT_FIELDS = [
  'gender',
  'race',
  'ethnicity',
  'religion',
  'age',
  'national_origin',
  'disability',
];

/**
 * Optional ZIP centroids for haversine between different ZIPs (no external API).
 * @type {Record<string, { lat: number, lng: number }>}
 */
const ZIP_COORDS = {
  '10001': { lat: 40.7506, lng: -73.9971 },
  '10002': { lat: 40.7157, lng: -73.9863 },
  '11201': { lat: 40.6943, lng: -73.9866 },
  '19103': { lat: 39.9522, lng: -75.1652 },
  '30301': { lat: 33.749, lng: -84.388 },
  '60601': { lat: 41.8853, lng: -87.6217 },
  '73301': { lat: 30.2672, lng: -97.7431 },
  '75201': { lat: 32.7876, lng: -96.7994 },
  '77001': { lat: 29.7604, lng: -95.3698 },
  '85001': { lat: 33.4484, lng: -112.074 },
  '90001': { lat: 33.9731, lng: -118.2479 },
  '90210': { lat: 34.0901, lng: -118.4065 },
  '94102': { lat: 37.7793, lng: -122.4193 },
  '98101': { lat: 47.6101, lng: -122.3421 },
};

const DISTANCE_SCORE_BY_MILES = [
  [0, 40],
  [5, 32],
  [15, 24],
  [25, 16],
  [50, 8],
  [Infinity, 0],
];

const PET_COMFORT_COVERS = {
  none: new Set(),
  cats: new Set(['cat', 'cats']),
  dogs: new Set(['dog', 'dogs']),
  cats_and_dogs: new Set(['cat', 'cats', 'dog', 'dogs']),
  all_pets: new Set(['cat', 'cats', 'dog', 'dogs', 'pet', 'pets']),
};

const SERVICE_FLAG_BY_KEY = {
  deep_cleaning: 'deep_cleaning_available',
  move_in_move_out: 'move_in_move_out_available',
  recurring_cleaning: 'recurring_cleaning_available',
  one_time_cleaning: 'one_time_cleaning_available',
};

/**
 * @param {string | null | undefined} zip
 */
export function normalizeZip(zip) {
  if (zip == null || zip === '') return '';
  return String(zip).replace(/\D/g, '').slice(0, 5);
}

/**
 * @param {string | null | undefined} value
 */
function normalizePlace(value) {
  if (value == null) return '';
  return String(value).trim().toLowerCase();
}

/**
 * @param {string | null | undefined} value
 */
function normalizeLanguageCode(value) {
  if (value == null || value === '') return '';
  return String(value).trim().toLowerCase().replace(/_/g, '-').split('-')[0];
}

/**
 * @param {{ lat: number, lng: number }} a
 * @param {{ lat: number, lng: number }} b
 */
export function haversineMiles(a, b) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

/**
 * @param {string} zipA
 * @param {string} zipB
 * @returns {{ distance_miles: number, distance_label: string } | null}
 */
function distanceFromZipCentroids(zipA, zipB) {
  const a = normalizeZip(zipA);
  const b = normalizeZip(zipB);
  if (!a || !b || a === b) return null;
  const ca = ZIP_COORDS[a];
  const cb = ZIP_COORDS[b];
  if (!ca || !cb) return null;
  const miles = haversineMiles(ca, cb);
  const rounded = Math.round(miles * 10) / 10;
  return {
    distance_miles: rounded,
    distance_label: rounded < 1 ? 'Same ZIP' : `~${Math.round(rounded)} mi`,
  };
}

/**
 * Rule-based distance between a request and one cleaner service area.
 * @param {LocationLike} request
 * @param {ServiceAreaLike} area
 */
export function distanceBetweenLocations(request, area) {
  const reqZip = normalizeZip(request.zip_code);
  const areaZip = normalizeZip(area.zip_code);

  if (reqZip && areaZip && reqZip === areaZip) {
    return { distance_miles: 0, distance_label: 'Same ZIP' };
  }

  const fromCoords =
    reqZip && areaZip ? distanceFromZipCentroids(reqZip, areaZip) : null;
  if (fromCoords) return fromCoords;

  const reqCity = normalizePlace(request.city);
  const areaCity = normalizePlace(area.city);
  const reqState = normalizePlace(request.state);
  const areaState = normalizePlace(area.state);

  if (reqCity && areaCity && reqCity === areaCity && reqState === areaState) {
    return { distance_miles: 5, distance_label: 'Same city' };
  }
  if (reqState && areaState && reqState === areaState) {
    return { distance_miles: 25, distance_label: 'Same state' };
  }
  return { distance_miles: 100, distance_label: 'Far' };
}

/**
 * Closest service area to the request (minimum distance_miles).
 * @param {LocationLike} request
 * @param {ServiceAreaLike[]} serviceAreas
 */
export function closestServiceAreaDistance(request, serviceAreas) {
  if (!serviceAreas?.length) {
    return { distance_miles: 100, distance_label: 'No service area', area: null };
  }

  let best = null;
  let bestArea = null;
  for (const area of serviceAreas) {
    const d = distanceBetweenLocations(request, area);
    if (!best || d.distance_miles < best.distance_miles) {
      best = d;
      bestArea = area;
    }
  }
  return { ...best, area: bestArea };
}

/**
 * @param {number} distanceMiles
 */
export function distancePointsForMiles(distanceMiles) {
  for (const [maxMiles, points] of DISTANCE_SCORE_BY_MILES) {
    if (distanceMiles <= maxMiles) return points;
  }
  return 0;
}

/**
 * @param {{ distance_miles?: number | null, score?: number | null }} a
 * @param {{ distance_miles?: number | null, score?: number | null }} b
 */
export function compareByDistanceThenScore(a, b) {
  const da = a.distance_miles ?? Number.POSITIVE_INFINITY;
  const db_ = b.distance_miles ?? Number.POSITIVE_INFINITY;
  if (da !== db_) return da - db_;
  return (b.score ?? 0) - (a.score ?? 0);
}

/**
 * @param {number} distanceMiles
 * @param {string} distanceLabel
 */
function distanceReasonFirst(distanceMiles, distanceLabel) {
  if (distanceMiles === 0) return distanceLabel;
  if (distanceLabel.startsWith('~')) return distanceLabel;
  return `${distanceLabel} (~${distanceMiles} mi)`;
}

/**
 * @param {object} request
 */
export function parsePreferredDays(request) {
  if (request.preferred_day != null) {
    const day = Number(request.preferred_day);
    return Number.isNaN(day) ? [] : [day];
  }
  if (!request.preferred_days) return [];
  try {
    const days = JSON.parse(request.preferred_days);
    if (Array.isArray(days)) {
      return days.map(Number).filter((n) => !Number.isNaN(n));
    }
    const single = Number(days);
    return Number.isNaN(single) ? [] : [single];
  } catch {
    const n = Number(request.preferred_days);
    return Number.isNaN(n) ? [] : [n];
  }
}

/**
 * @param {object} request
 */
export function parsePreferredTimeWindows(request) {
  if (!request.preferred_time_windows) return [];
  try {
    const windows = JSON.parse(request.preferred_time_windows);
    return Array.isArray(windows) ? windows : [];
  } catch {
    return [];
  }
}

/**
 * @param {string | null | undefined} text
 */
export function parseRequestPetTypes(text) {
  const normalized = normalizePlace(text);
  if (!normalized || normalized === 'none' || normalized === 'no pets' || normalized === 'no') {
    return [];
  }
  const types = new Set();
  if (/\bcat(s)?\b/.test(normalized)) types.add('cats');
  if (/\bdog(s)?\b/.test(normalized)) types.add('dogs');
  if (!types.size && /\bpet(s)?\b/.test(normalized)) types.add('pets');
  return [...types];
}

/**
 * @param {string | null | undefined} comfortLevel
 * @param {string[]} requestPetTypes
 */
export function petsCompatible(comfortLevel, requestPetTypes) {
  if (!requestPetTypes.length) {
    return { compatible: true, reason: null, warning: null };
  }
  const level = comfortLevel || 'none';
  const covers = PET_COMFORT_COVERS[level] ?? PET_COMFORT_COVERS.none;
  const compatible = requestPetTypes.every((petType) => {
    if (petType === 'pets') return level === 'all_pets';
    return covers.has(petType);
  });
  if (compatible) {
    return { compatible: true, reason: 'Comfortable with household pets', warning: null };
  }
  return {
    compatible: false,
    reason: null,
    warning: 'Pet comfort level may not match household pets',
  };
}

/**
 * @param {object} request
 * @param {object} profile
 */
export function suppliesCompatible(request, profile) {
  const homeownerHasSupplies = !!request.supplies_available;
  const cleanerBringsSupplies = !!profile.supplies_included;
  if (homeownerHasSupplies || cleanerBringsSupplies) {
    return {
      compatible: true,
      reason: cleanerBringsSupplies ? 'Brings own supplies' : 'Homeowner supplies available',
      warning: null,
    };
  }
  return {
    compatible: false,
    reason: null,
    warning: 'Supplies not included and none listed at home',
  };
}

/**
 * @param {object} profile
 * @param {Array<{ language_code?: string, language_name?: string }>} languageRows
 */
export function normalizeCleanerLanguages(profile, languageRows = []) {
  if (languageRows.length) return languageRows;
  if (!profile?.languages) return [];
  try {
    const parsed = JSON.parse(profile.languages);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => {
      if (typeof entry === 'string') {
        return { language_code: normalizeLanguageCode(entry), language_name: entry };
      }
      return {
        language_code: normalizeLanguageCode(entry.language_code ?? entry.code ?? entry.name),
        language_name: entry.language_name ?? entry.name ?? entry.language_code ?? entry.code ?? '',
      };
    });
  } catch {
    return [];
  }
}

/**
 * @param {object} request
 * @param {Array<{ language_code?: string, language_name?: string }>} cleanerLanguages
 */
export function languageMatches(request, cleanerLanguages) {
  const preferred =
    request.preferred_communication_language_code ??
    request.preferred_communication_language ??
    request.preferred_language ??
    null;
  if (!preferred) {
    return { matched: false, skipped: true, reason: null, warning: null };
  }
  const preferredCode = normalizeLanguageCode(preferred);
  const preferredName = normalizePlace(preferred);
  const matched = cleanerLanguages.some((lang) => {
    const code = normalizeLanguageCode(lang.language_code ?? lang.language_name);
    const name = normalizePlace(lang.language_name);
    return (preferredCode && code === preferredCode) || (preferredName && name === preferredName);
  });
  if (matched) {
    return {
      matched: true,
      skipped: false,
      reason: 'Cleaner speaks your preferred communication language',
      warning: null,
    };
  }
  return {
    matched: false,
    skipped: false,
    reason: null,
    warning: 'Preferred communication language not listed on profile',
  };
}

/**
 * @param {string} key
 */
function normalizeServiceKey(key) {
  return String(key)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_');
}

/**
 * @param {object} request
 * @param {Array<{ is_deep_clean?: number }>} [tasks]
 */
export function inferRequestServiceTypes(request, tasks = []) {
  const types = new Set();
  if (request.frequency === 'one_time') types.add('one_time_cleaning');
  else if (['weekly', 'biweekly', 'monthly'].includes(request.frequency)) {
    types.add('recurring_cleaning');
  }

  if (request.service_type) types.add(normalizeServiceKey(request.service_type));
  if (request.is_move_in_move_out || request.move_in_move_out) types.add('move_in_move_out');
  if (tasks.some((task) => task.is_deep_clean)) types.add('deep_cleaning');

  if (!types.size) types.add('standard_cleaning');
  return [...types];
}

/**
 * @param {object} profile
 * @param {Array<{ service_key?: string, is_offered?: number }>} services
 * @param {string} serviceKey
 */
export function cleanerOffersService(profile, services, serviceKey) {
  const key = normalizeServiceKey(serviceKey);
  const offered = services.some(
    (row) => normalizeServiceKey(row.service_key) === key && row.is_offered
  );
  if (offered) return true;

  const flag = SERVICE_FLAG_BY_KEY[key];
  if (flag && profile?.[flag] != null) return !!profile[flag];
  return key === 'standard_cleaning';
}

/**
 * @param {object} request
 * @param {object} profile
 */
export function productPrefsCompatible(request, profile) {
  const reasons = [];
  const warnings = [];

  const wantsFragranceFree =
    request.fragrance_free_required ?? request.fragrance_free ?? request.requires_fragrance_free;
  if (wantsFragranceFree) {
    if (profile.fragrance_free_available) {
      reasons.push('Fragrance-free products available');
    } else {
      warnings.push('Fragrance-free products not listed');
    }
  }

  const wantsEcoFriendly =
    request.eco_friendly_required ?? request.eco_friendly ?? request.requires_eco_friendly;
  if (wantsEcoFriendly) {
    if (profile.eco_friendly_products_available) {
      reasons.push('Eco-friendly products available');
    } else {
      warnings.push('Eco-friendly products not listed');
    }
  }

  const homeownerAllowsBleach = request.bleach_allowed;
  const homeownerNoBleach = request.no_bleach ?? request.bleach_free;
  if (homeownerNoBleach || homeownerAllowsBleach === 0 || homeownerAllowsBleach === false) {
    if (profile.bleach_allowed === 0 || profile.bleach_allowed === false) {
      reasons.push('No bleach used');
    } else if (profile.bleach_allowed) {
      warnings.push('Cleaner may use bleach; homeowner prefers bleach-free');
    }
  } else if (homeownerAllowsBleach && profile.bleach_allowed) {
    reasons.push('Bleach use acceptable');
  }

  return { reasons, warnings };
}

/**
 * @param {string} startA
 * @param {string} endA
 * @param {string} startB
 * @param {string} endB
 */
function timeRangesOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

/**
 * @param {Array<object>} availability
 * @param {number[]} preferredDays
 * @param {Array<object>} preferredWindows
 */
export function availabilityMatches(availability, preferredDays, preferredWindows) {
  const openSlots = availability.filter((slot) => slot.is_available);
  if (!openSlots.length) {
    return { matched: false, partial: false, reason: null, warning: 'No availability listed' };
  }

  const days = preferredDays.length ? preferredDays : null;
  if (days) {
    const dayMatches = days.filter((day) =>
      openSlots.some((slot) => slot.day_of_week === day)
    );
    if (!dayMatches.length) {
      return {
        matched: false,
        partial: false,
        reason: null,
        warning: 'Preferred day mismatch',
      };
    }
    if (preferredWindows.length) {
      const windowMatches = preferredWindows.some((window) => {
        const day = Number(window.day_of_week ?? window.day);
        const start = window.start_time ?? window.start;
        const end = window.end_time ?? window.end;
        if (Number.isNaN(day) || !start || !end) return false;
        return openSlots.some(
          (slot) =>
            slot.day_of_week === day &&
            timeRangesOverlap(slot.start_time, slot.end_time, start, end)
        );
      });
      if (windowMatches) {
        return { matched: true, partial: false, reason: 'Available during preferred times', warning: null };
      }
      return {
        matched: false,
        partial: true,
        reason: 'Available on preferred day',
        warning: 'Preferred time window mismatch',
      };
    }
    if (dayMatches.length === days.length) {
      return { matched: true, partial: false, reason: 'Available on preferred days', warning: null };
    }
    return {
      matched: false,
      partial: true,
      reason: 'Available on some preferred days',
      warning: 'Not available on all preferred days',
    };
  }

  return { matched: true, partial: false, reason: 'Has weekly availability', warning: null };
}

/**
 * @param {object} profile
 * @param {ServiceAreaLike[]} serviceAreas
 * @param {Array<object>} availability
 * @param {Array<object>} languages
 * @param {Array<object>} services
 */
export function computeProfileCompletionPercent(profile, serviceAreas, availability, languages, services) {
  const hasServiceOffered =
    services.some((row) => row.is_offered) ||
    Object.values(SERVICE_FLAG_BY_KEY).some((flag) => profile?.[flag]);

  const checks = [
    !!profile?.display_name,
    Number(profile?.hourly_rate_cents) > 0,
    Number(profile?.minimum_visit_minutes) > 0 || Number(profile?.minimum_visit_cents) > 0,
    serviceAreas.length > 0,
    availability.some((slot) => slot.is_available),
    languages.length > 0,
    hasServiceOffered,
    ['complete', 'pending'].includes(profile?.stripe_onboarding_status ?? ''),
    profile?.profile_status === 'approved' || profile?.profile_status === 'pending_review',
  ];

  const completed = checks.filter(Boolean).length;
  return Math.round((completed / checks.length) * 100);
}

/**
 * @param {object} profile
 * @param {ServiceAreaLike[]} serviceAreas
 * @param {Array<object>} availability
 * @param {object} request
 * @param {Array<object>} [languages]
 * @param {Array<object>} [services]
 * @param {Array<object>} [tasks]
 */
export function scoreCleanerForRequest(
  profile,
  serviceAreas,
  availability,
  request,
  { languages = [], services = [], tasks = [] } = {}
) {
  const { distance_miles, distance_label, area: closestArea } = closestServiceAreaDistance(
    request,
    serviceAreas
  );
  let score = distancePointsForMiles(distance_miles);
  const reasons = [distanceReasonFirst(distance_miles, distance_label)];
  const warnings = [];

  const servesZip = serviceAreas.some(
    (area) => normalizeZip(area.zip_code) === normalizeZip(request.zip_code)
  );
  if (servesZip) {
    score += 8;
    reasons.push(`Serves ZIP ${normalizeZip(request.zip_code)}`);
  } else {
    warnings.push('Outside primary ZIP');
  }

  if (closestArea?.radius_miles != null && distance_miles > closestArea.radius_miles) {
    warnings.push('May be outside stated service radius');
  }

  const preferredDays = parsePreferredDays(request);
  const preferredWindows = parsePreferredTimeWindows(request);
  const availabilityResult = availabilityMatches(availability, preferredDays, preferredWindows);
  if (availabilityResult.reason) {
    score += availabilityResult.partial ? 6 : 12;
    reasons.push(availabilityResult.reason);
  }
  if (availabilityResult.warning) warnings.push(availabilityResult.warning);

  const cleanerLanguages = normalizeCleanerLanguages(profile, languages);
  const languageResult = languageMatches(request, cleanerLanguages);
  if (languageResult.reason) {
    score += 8;
    reasons.push(languageResult.reason);
  }
  if (languageResult.warning) warnings.push(languageResult.warning);

  const requestServiceTypes = inferRequestServiceTypes(request, tasks);
  const matchedServices = requestServiceTypes.filter((serviceKey) =>
    cleanerOffersService(profile, services, serviceKey)
  );
  if (matchedServices.length) {
    score += Math.min(10, matchedServices.length * 5);
    const labels = matchedServices.map((key) => key.replace(/_/g, ' '));
    reasons.push(`Offers requested service: ${labels.join(', ')}`);
  }
  const missingServices = requestServiceTypes.filter(
    (serviceKey) => !cleanerOffersService(profile, services, serviceKey)
  );
  if (missingServices.length) {
    warnings.push(`May not offer: ${missingServices.map((k) => k.replace(/_/g, ' ')).join(', ')}`);
  }

  if (request.homeowner_budget_max_cents && profile.hourly_rate_cents <= request.homeowner_budget_max_cents) {
    score += 10;
    reasons.push('Rate fits homeowner budget');
  } else if (request.homeowner_budget_max_cents) {
    warnings.push('Rate above stated budget');
  } else if (profile.hourly_rate_cents) {
    score += 3;
    reasons.push('Rate listed');
  }

  const suppliesResult = suppliesCompatible(request, profile);
  if (suppliesResult.reason) {
    score += 8;
    reasons.push(suppliesResult.reason);
  }
  if (suppliesResult.warning) warnings.push(suppliesResult.warning);

  const requestPetTypes = parseRequestPetTypes(request.pets);
  const petResult = petsCompatible(profile.pet_comfort_level, requestPetTypes);
  if (petResult.reason) {
    score += 8;
    reasons.push(petResult.reason);
  }
  if (petResult.warning) warnings.push(petResult.warning);

  const productResult = productPrefsCompatible(request, profile);
  if (productResult.reasons.length) {
    score += Math.min(9, productResult.reasons.length * 3);
    reasons.push(...productResult.reasons);
  }
  warnings.push(...productResult.warnings);

  const completionPercent = computeProfileCompletionPercent(
    profile,
    serviceAreas,
    availability,
    cleanerLanguages,
    services
  );
  const completionBonus = Math.round(completionPercent / 20);
  if (completionBonus > 0) {
    score += completionBonus;
    reasons.push(`Profile ${completionPercent}% complete`);
  }
  if (completionPercent < 70) {
    warnings.push('Profile still missing recommended details');
  }

  if (profile.profile_status === 'approved') {
    score += 5;
    reasons.push('Approved profile');
  }

  if (profile.stripe_onboarding_status === 'complete') {
    score += 5;
    reasons.push('Payout setup complete');
  } else if (profile.stripe_onboarding_status) {
    warnings.push('Stripe payout setup incomplete');
  }

  if (profile.accepts_new_clients) {
    score += 3;
    reasons.push('Accepting new clients');
  }

  return {
    cleaner_profile_id: profile.id,
    user_id: profile.user_id,
    display_name: profile.display_name,
    cleaner_name: profile.display_name,
    score: Math.min(100, score),
    distance_miles,
    distance_label,
    profile_completion_percent: completionPercent,
    reasons,
    warnings,
  };
}

/**
 * Rule-based match score for a proposal shown to a homeowner.
 * @param {object} proposal
 * @param {object} request
 * @param {object} profile
 * @param {ServiceAreaLike[]} [serviceAreas]
 */
export function scoreProposalForHomeowner(proposal, request, profile, serviceAreas = []) {
  const closest = closestServiceAreaDistance(request, serviceAreas);
  const { distance_miles, distance_label } = closest;
  const reasons = [distanceReasonFirst(distance_miles, distance_label)];
  const warnings = [];

  let score = distancePointsForMiles(distance_miles);
  if (profile?.profile_status === 'approved') {
    score += 15;
    reasons.push('Approved profile');
  }
  if (profile?.accepts_new_clients) {
    score += 5;
    reasons.push('Accepting new clients');
  }
  if (proposal.supplies_included) {
    score += 10;
    reasons.push('Supplies included');
  }

  const preferredDays = parsePreferredDays(request);
  if (preferredDays.length && proposal.proposed_day === preferredDays[0]) {
    score += 10;
    reasons.push('Available on preferred day');
  }

  if (request?.homeowner_budget_max_cents && proposal.hourly_rate_cents <= request.homeowner_budget_max_cents) {
    score += 10;
    reasons.push('Rate fits budget');
  } else if (request?.homeowner_budget_max_cents) {
    warnings.push('Rate above stated budget');
  }

  const scopeMinutes = request?.estimated_minutes || 0;
  if (scopeMinutes > 0) {
    const diff = Math.abs(proposal.recurring_estimated_minutes - scopeMinutes);
    if (diff <= 15) {
      score += 10;
      reasons.push('Scope time aligns');
    } else if (diff <= 30) {
      score += 5;
      reasons.push('Scope time close');
    }
  }

  if (profile?.experience_years >= 3) {
    score += 5;
    reasons.push('Experienced cleaner');
  }

  if (closest.area?.radius_miles != null && distance_miles > closest.area.radius_miles) {
    warnings.push('May be outside stated service radius');
  }

  return {
    score: Math.min(100, score),
    distance_miles,
    distance_label,
    reasons,
    warnings,
  };
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
  return copy.sort(compareByDistanceThenScore);
}

function tableExists(name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return !!row;
}

function loadCleanerLanguages(cleanerProfileId) {
  if (!tableExists('cleaner_languages')) return [];
  return db
    .prepare('SELECT * FROM cleaner_languages WHERE cleaner_profile_id = ?')
    .all(cleanerProfileId);
}

function loadCleanerServices(cleanerProfileId) {
  if (!tableExists('cleaner_services')) return [];
  return db
    .prepare('SELECT * FROM cleaner_services WHERE cleaner_profile_id = ?')
    .all(cleanerProfileId);
}

function loadRequestTasks(requestId) {
  return db
    .prepare('SELECT * FROM cleaning_request_tasks WHERE request_id = ? ORDER BY sort_order')
    .all(requestId);
}

function isEligibleForMatch(profile, serviceAreas, availability) {
  if (profile.profile_status !== 'approved') return false;
  if (!profile.accepts_new_clients) return false;
  if (!serviceAreas.length) return false;
  if (!availability.some((slot) => slot.is_available)) return false;
  if (!(Number(profile.hourly_rate_cents) > 0)) return false;
  if (
    profile.stripe_onboarding_status != null &&
    profile.stripe_onboarding_status !== '' &&
    profile.stripe_onboarding_status !== 'complete'
  ) {
    return false;
  }
  return true;
}

export function rankCleanersForRequest(requestId) {
  const request = db.prepare('SELECT * FROM cleaning_requests WHERE id = ?').get(requestId);
  assertFound(request, 'Cleaning request not found');

  const tasks = loadRequestTasks(requestId);

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

    if (!serviceAreas.some((area) => normalizeZip(area.zip_code) === normalizeZip(request.zip_code))) {
      continue;
    }

    if (!isEligibleForMatch(profile, serviceAreas, availability)) {
      continue;
    }

    const languages = loadCleanerLanguages(profile.id);
    const services = loadCleanerServices(profile.id);

    results.push(
      scoreCleanerForRequest(
        { ...profile, display_name: profile.display_name || profile.user_display_name },
        serviceAreas,
        availability,
        request,
        { languages, services, tasks }
      )
    );
  }

  return results.sort(compareByDistanceThenScore);
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
