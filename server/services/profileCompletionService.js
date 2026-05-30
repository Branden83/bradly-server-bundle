import db from '../db.js';
import { assertFound, ServiceError } from '../lib/serviceError.js';
import { getCleanerConnectStatus, isStripeOnboardingComplete } from './stripeConnectService.js';
import { listAvailabilityForProfileId } from './cleanerAvailabilityService.js';
import { listLanguagesForProfileId } from './cleanerLanguageService.js';
import { listOfferedServicesForProfileId } from './cleanerServicesService.js';
import { listServiceAreasForProfileId } from './cleanerServiceAreaService.js';
import { getProfileRowByUserId } from './cleanerProfileHelpers.js';

/** Weighted checklist items for profile completion (excludes admin-only gates). */
export const COMPLETION_ITEMS = Object.freeze([
  { key: 'display_name', label: 'Display name', weight: 10 },
  { key: 'bio', label: 'Bio', weight: 10 },
  { key: 'hourly_rate', label: 'Hourly rate', weight: 15 },
  { key: 'service_area', label: 'Service area', weight: 15 },
  { key: 'availability', label: 'Availability', weight: 15 },
  { key: 'offered_service', label: 'Offered service', weight: 10 },
  { key: 'language', label: 'Language', weight: 5 },
  { key: 'stripe_onboarding', label: 'Payment setup', weight: 20 },
]);

/**
 * @param {string} userId
 * @returns {{
 *   profile: object | null,
 *   serviceAreas: object[],
 *   availability: object[],
 *   languages: object[],
 *   offeredServices: object[],
 *   stripeReady: boolean,
 * }}
 */
export function loadProfileCompletionContext(userId) {
  const profile = getProfileRowByUserId(userId);
  if (!profile) {
    return {
      profile: null,
      serviceAreas: [],
      availability: [],
      languages: [],
      offeredServices: [],
      stripeReady: false,
    };
  }

  const serviceAreas = listServiceAreasForProfileId(profile.id);
  const availability = listAvailabilityForProfileId(profile.id);
  const languages = listLanguagesForProfileId(profile.id);
  const offeredServices = listOfferedServicesForProfileId(profile.id);
  const stripeReady = isStripeOnboardingComplete(userId);

  return { profile, serviceAreas, availability, languages, offeredServices, stripeReady };
}

/**
 * @param {ReturnType<typeof loadProfileCompletionContext>} ctx
 */
export function evaluateCompletion(ctx) {
  const missing = [];
  let earned = 0;
  let totalWeight = 0;

  for (const item of COMPLETION_ITEMS) {
    totalWeight += item.weight;
    const complete = isCompletionItemComplete(item.key, ctx);
    if (complete) {
      earned += item.weight;
    } else {
      missing.push(item.key);
    }
  }

  const completion_percent = totalWeight ? Math.round((earned / totalWeight) * 100) : 0;

  return {
    completion_percent,
    missing_items: missing,
    can_receive_payments: ctx.stripeReady,
    can_accept_new_clients: computeCanAcceptNewClients(ctx),
    can_send_proposals: computeCanSendProposals(ctx),
  };
}

function isCompletionItemComplete(key, ctx) {
  const { profile, serviceAreas, availability, languages, offeredServices, stripeReady } = ctx;
  if (!profile) return false;

  switch (key) {
    case 'display_name':
      return Boolean(profile.display_name?.trim());
    case 'bio':
      return Boolean(profile.bio?.trim()?.length >= 20);
    case 'hourly_rate':
      return Number.isInteger(profile.hourly_rate_cents) && profile.hourly_rate_cents >= 100;
    case 'service_area':
      return serviceAreas.length > 0;
    case 'availability':
      return availability.some((slot) => slot.is_available);
    case 'offered_service':
      return offeredServices.length > 0;
    case 'language':
      return languages.length > 0;
    case 'stripe_onboarding':
      return stripeReady;
    default:
      return false;
  }
}

/**
 * Match marketplace visibility — operational readiness without admin approval.
 */
function computeCanAcceptNewClients(ctx) {
  const { profile } = ctx;
  if (!profile?.accepts_new_clients) return false;
  return hasMatchOperationalRequirements(ctx);
}

/**
 * Match proposals — requires admin approval plus operational readiness.
 * BYOC invite join does not use this gate.
 */
function computeCanSendProposals(ctx) {
  const { profile } = ctx;
  if (!profile || profile.profile_status !== 'approved') return false;
  if (!profile.accepts_new_clients) return false;
  return hasMatchOperationalRequirements(ctx);
}

function hasMatchOperationalRequirements(ctx) {
  const { profile, serviceAreas, availability, stripeReady } = ctx;
  if (!profile) return false;
  if (!Number.isInteger(profile.hourly_rate_cents) || profile.hourly_rate_cents < 100) {
    return false;
  }
  if (!serviceAreas.length) return false;
  if (!availability.some((slot) => slot.is_available)) return false;
  if (!stripeReady) return false;
  return true;
}

/**
 * @param {string} userId
 */
export function getProfileCompletion(userId) {
  const ctx = loadProfileCompletionContext(userId);
  return evaluateCompletion(ctx);
}

/**
 * @param {string} userId
 */
export function getProfileCompletionByProfileId(profileId) {
  const row = db.prepare('SELECT user_id FROM cleaner_profiles WHERE id = ?').get(profileId);
  assertFound(row, 'Profile not found');
  return getProfileCompletion(row.user_id);
}

/**
 * Minimum fields required before submitForReview.
 * @param {string} userId
 */
export function assertReadyForReview(userId) {
  const ctx = loadProfileCompletionContext(userId);
  assertFound(ctx.profile, 'Profile not found');

  const blockers = [];
  if (!ctx.profile.display_name?.trim()) blockers.push('display_name');
  if (!Number.isInteger(ctx.profile.hourly_rate_cents) || ctx.profile.hourly_rate_cents < 100) {
    blockers.push('hourly_rate');
  }
  if (!ctx.serviceAreas.length) blockers.push('service_area');
  if (!ctx.availability.some((slot) => slot.is_available)) blockers.push('availability');
  if (!ctx.offeredServices.length) blockers.push('offered_service');

  if (blockers.length) {
    throw new ServiceError('Complete required profile sections before submitting for review', {
      status: 400,
      code: 'profile_incomplete',
    });
  }
}
