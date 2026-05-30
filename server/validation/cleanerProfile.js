import { ServiceError } from '../lib/serviceError.js';
import {
  optionalBoolean,
  optionalPositiveInt,
  optionalString,
  requireBoolean,
  requireDayOfWeek,
  requireEnum,
  requireNonNegativeInt,
  requirePositiveInt,
  requireState,
  requireString,
  requireTime,
  requireZip,
  validateProfileStatus,
} from './marketplace.js';

export const PET_COMFORT_LEVELS = new Set(['none', 'cats', 'dogs', 'cats_and_dogs', 'all_pets']);
export const LANGUAGE_PROFICIENCIES = new Set(['basic', 'conversational', 'fluent', 'native']);
export const STRIPE_ONBOARDING_STATUSES = new Set([
  'not_started',
  'pending',
  'complete',
  'restricted',
]);
export const BACKGROUND_CHECK_STATUSES = new Set(['not_provided', 'pending', 'verified', 'failed']);
export const INSURANCE_STATUSES = new Set(['not_provided', 'pending', 'verified', 'expired']);

export const SERVICE_CATALOG = Object.freeze({
  standard_cleaning: { key: 'standard_cleaning', label: 'Standard cleaning' },
  deep_cleaning: { key: 'deep_cleaning', label: 'Deep cleaning' },
  move_in_move_out: { key: 'move_in_move_out', label: 'Move-in / move-out' },
  recurring_cleaning: { key: 'recurring_cleaning', label: 'Recurring cleaning' },
  one_time_cleaning: { key: 'one_time_cleaning', label: 'One-time cleaning' },
});

export const SERVICE_KEYS = new Set(Object.keys(SERVICE_CATALOG));

export function validatePetComfortLevel(value) {
  return requireEnum(value, 'pet comfort level', PET_COMFORT_LEVELS);
}

export function validateLanguageProficiency(value) {
  return requireEnum(value, 'language proficiency', LANGUAGE_PROFICIENCIES);
}

export function validateStripeOnboardingStatus(value) {
  return requireEnum(value, 'stripe onboarding status', STRIPE_ONBOARDING_STATUSES);
}

export function validateServiceKey(value) {
  return requireEnum(value, 'service key', SERVICE_KEYS);
}

export function validateLanguageCode(value) {
  const code = requireString(value, 'language code', { min: 2, max: 16 }).toLowerCase();
  if (!/^[a-z0-9_]+$/.test(code)) {
    throw new ServiceError('Language code must use letters, numbers, or underscores');
  }
  return code;
}

export function validateProfilePhotoUrl(value) {
  if (value == null || value === '') return null;
  const url = requireString(value, 'profile photo URL', { max: 2000 });
  if (!/^https?:\/\//i.test(url)) {
    throw new ServiceError('Profile photo URL must start with http:// or https://');
  }
  return url;
}

/**
 * @param {object} body
 * @param {{ forCreate?: boolean }} [options]
 */
export function validateProfileInput(body, { forCreate = false } = {}) {
  const out = {};

  if (forCreate || body.displayName != null || body.display_name != null) {
    out.display_name = requireString(
      body.displayName ?? body.display_name ?? '',
      'display name',
      { max: 120 }
    );
  }

  if (body.bio != null) {
    out.bio = String(body.bio).trim().slice(0, 2000);
  }

  if (body.profilePhotoUrl != null || body.profile_photo_url != null) {
    out.profile_photo_url = validateProfilePhotoUrl(body.profilePhotoUrl ?? body.profile_photo_url);
  }

  if (body.experienceYears != null || body.experience_years != null) {
    out.experience_years = requireNonNegativeInt(
      body.experienceYears ?? body.experience_years,
      'experience years',
      { max: 60 }
    );
  }

  if (body.hourlyRateCents != null || body.hourly_rate_cents != null) {
    out.hourly_rate_cents = requirePositiveInt(
      body.hourlyRateCents ?? body.hourly_rate_cents,
      'hourly rate',
      { min: 100, max: 50000 }
    );
  }

  if (body.minimumVisitMinutes != null || body.minimum_visit_minutes != null) {
    out.minimum_visit_minutes = requirePositiveInt(
      body.minimumVisitMinutes ?? body.minimum_visit_minutes,
      'minimum visit minutes',
      { min: 15, max: 480 }
    );
  }

  if (body.minimumVisitCents != null || body.minimum_visit_cents != null) {
    out.minimum_visit_cents = requireNonNegativeInt(
      body.minimumVisitCents ?? body.minimum_visit_cents,
      'minimum visit charge'
    );
  }

  if (body.acceptsNewClients != null || body.accepts_new_clients != null) {
    out.accepts_new_clients = body.acceptsNewClients ?? body.accepts_new_clients ? 1 : 0;
  }

  if (body.suppliesIncluded != null || body.supplies_included != null) {
    out.supplies_included = body.suppliesIncluded ?? body.supplies_included ? 1 : 0;
  }

  if (body.bringsVacuum != null || body.brings_vacuum != null) {
    out.brings_vacuum = body.bringsVacuum ?? body.brings_vacuum ? 1 : 0;
  }

  if (body.petComfortLevel != null || body.pet_comfort_level != null) {
    out.pet_comfort_level = validatePetComfortLevel(body.petComfortLevel ?? body.pet_comfort_level);
  }

  if (body.fragranceFreeAvailable != null || body.fragrance_free_available != null) {
    out.fragrance_free_available =
      body.fragranceFreeAvailable ?? body.fragrance_free_available ? 1 : 0;
  }

  if (body.ecoFriendlyProductsAvailable != null || body.eco_friendly_products_available != null) {
    out.eco_friendly_products_available =
      body.ecoFriendlyProductsAvailable ?? body.eco_friendly_products_available ? 1 : 0;
  }

  if (body.bleachAllowed != null || body.bleach_allowed != null) {
    out.bleach_allowed = body.bleachAllowed ?? body.bleach_allowed ? 1 : 0;
  }

  if (body.deepCleaningAvailable != null || body.deep_cleaning_available != null) {
    out.deep_cleaning_available =
      body.deepCleaningAvailable ?? body.deep_cleaning_available ? 1 : 0;
  }

  if (body.moveInMoveOutAvailable != null || body.move_in_move_out_available != null) {
    out.move_in_move_out_available =
      body.moveInMoveOutAvailable ?? body.move_in_move_out_available ? 1 : 0;
  }

  if (body.recurringCleaningAvailable != null || body.recurring_cleaning_available != null) {
    out.recurring_cleaning_available =
      body.recurringCleaningAvailable ?? body.recurring_cleaning_available ? 1 : 0;
  }

  if (body.oneTimeCleaningAvailable != null || body.one_time_cleaning_available != null) {
    out.one_time_cleaning_available =
      body.oneTimeCleaningAvailable ?? body.one_time_cleaning_available ? 1 : 0;
  }

  return out;
}

/**
 * @param {object} body
 */
export function validateLanguageInput(body) {
  return {
    language_code: validateLanguageCode(body.languageCode ?? body.language_code),
    language_name: requireString(body.languageName ?? body.language_name, 'language name', {
      max: 120,
    }),
    proficiency: validateLanguageProficiency(
      body.proficiency ?? 'conversational'
    ),
  };
}

/**
 * @param {object} body
 */
export function validateServiceAreaInput(body) {
  const zipCode = requireZip(body.zipCode ?? body.zip_code);
  const city = requireString(body.city, 'city', { max: 120 });
  const state = requireState(body.state);
  const radiusMiles =
    body.radiusMiles != null || body.radius_miles != null
      ? requirePositiveInt(body.radiusMiles ?? body.radius_miles, 'radius miles', {
          min: 1,
          max: 100,
        })
      : null;
  const isPrimary =
    body.isPrimary != null || body.is_primary != null
      ? body.isPrimary ?? body.is_primary
        ? 1
        : 0
      : 0;

  return { zip_code: zipCode, city, state, radius_miles: radiusMiles, is_primary: isPrimary };
}

/**
 * @param {object} body
 */
export function validateAvailabilityInput(body) {
  const dayOfWeek = requireDayOfWeek(body.dayOfWeek ?? body.day_of_week);
  const startTime = requireTime(body.startTime ?? body.start_time, 'start time');
  const endTime = requireTime(body.endTime ?? body.end_time, 'end time');
  const isAvailable = body.isAvailable ?? body.is_available ?? true;
  const notes = optionalString(body.notes, 'notes', { max: 500 }) ?? '';

  if (startTime >= endTime) {
    throw new ServiceError('End time must be after start time');
  }

  return {
    day_of_week: dayOfWeek,
    start_time: startTime,
    end_time: endTime,
    is_available: isAvailable ? 1 : 0,
    notes,
  };
}

/**
 * @param {object} body
 */
export function validateOfferedServiceInput(body) {
  const serviceKey = validateServiceKey(body.serviceKey ?? body.service_key);
  const catalog = SERVICE_CATALOG[serviceKey];
  const isOffered =
    body.isOffered != null || body.is_offered != null
      ? body.isOffered ?? body.is_offered
        ? 1
        : 0
      : 1;

  return {
    service_key: serviceKey,
    service_label: requireString(
      body.serviceLabel ?? body.service_label ?? catalog.label,
      'service label',
      { max: 120 }
    ),
    is_offered: isOffered,
  };
}

export {
  validateProfileStatus,
  requireBoolean,
  optionalBoolean,
  optionalPositiveInt,
  requireDayOfWeek,
  requireTime,
};
