-- cleaner_profile_v2: expanded cleaner profile fields and normalized child tables.
-- Applied incrementally via migrateCleanerProfileV2() in db.js (idempotent column checks).

-- New columns on cleaner_profiles (added via ALTER in db.js for existing DBs).
-- profile_photo_url, pet_comfort_level, fragrance_free_available,
-- eco_friendly_products_available, bleach_allowed, deep_cleaning_available,
-- move_in_move_out_available, recurring_cleaning_available,
-- one_time_cleaning_available, stripe_onboarding_status

CREATE TABLE IF NOT EXISTS cleaner_languages (
  id TEXT PRIMARY KEY,
  cleaner_profile_id TEXT NOT NULL REFERENCES cleaner_profiles(id) ON DELETE CASCADE,
  language_code TEXT NOT NULL,
  language_name TEXT NOT NULL,
  proficiency TEXT NOT NULL DEFAULT 'conversational' CHECK (
    proficiency IN ('basic', 'conversational', 'fluent', 'native')
  ),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (cleaner_profile_id, language_code)
);

CREATE TABLE IF NOT EXISTS cleaner_services (
  id TEXT PRIMARY KEY,
  cleaner_profile_id TEXT NOT NULL REFERENCES cleaner_profiles(id) ON DELETE CASCADE,
  service_key TEXT NOT NULL,
  service_label TEXT NOT NULL,
  is_offered INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (cleaner_profile_id, service_key)
);

-- Extensions to cleaner_service_areas: is_primary, updated_at (via ALTER in db.js)
-- Extensions to cleaner_availability: notes (via ALTER in db.js)

CREATE INDEX IF NOT EXISTS idx_cleaner_languages_profile ON cleaner_languages(cleaner_profile_id);
CREATE INDEX IF NOT EXISTS idx_cleaner_services_profile ON cleaner_services(cleaner_profile_id);
CREATE INDEX IF NOT EXISTS idx_cleaner_profiles_stripe_onboarding ON cleaner_profiles(stripe_onboarding_status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cleaner_service_areas_profile_zip
  ON cleaner_service_areas(cleaner_profile_id, zip_code);
CREATE INDEX IF NOT EXISTS idx_cleaner_availability_profile_day
  ON cleaner_availability(cleaner_profile_id, day_of_week);
