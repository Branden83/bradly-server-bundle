CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('client', 'cleaner', 'admin')),
  push_token TEXT,
  subscription_status TEXT NOT NULL DEFAULT 'trial',
  subscription_trial_ends_at TEXT,
  subscription_expires_at TEXT,
  stripe_connect_account_id TEXT,
  stripe_connect_onboarding_complete INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS homes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  visit_day INTEGER NOT NULL DEFAULT 2,
  visit_time TEXT NOT NULL DEFAULT '10:00',
  hourly_rate_cents INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS home_members (
  home_id TEXT NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'cleaner')),
  PRIMARY KEY (home_id, user_id)
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS task_templates (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  cadence TEXT NOT NULL CHECK (cadence IN ('weekly', 'monthly', 'quarterly')),
  estimated_minutes INTEGER NOT NULL DEFAULT 15,
  priority TEXT NOT NULL DEFAULT 'must' CHECK (priority IN ('must', 'nice', 'skip_visit')),
  active INTEGER NOT NULL DEFAULT 1,
  last_completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS visits (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  scheduled_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'completed')),
  cleaner_response TEXT NOT NULL DEFAULT 'pending' CHECK (cleaner_response IN ('pending', 'accepted', 'declined')),
  cleaner_responded_at TEXT,
  decline_reason TEXT,
  decline_reason_text TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS visit_tasks (
  id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  task_template_id TEXT REFERENCES task_templates(id) ON DELETE SET NULL,
  room_name TEXT NOT NULL,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  cadence TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'must' CHECK (priority IN ('must', 'nice', 'skip_visit')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'skipped', 'blocked')),
  skip_reason TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS task_questions (
  id TEXT PRIMARY KEY,
  visit_task_id TEXT NOT NULL REFERENCES visit_tasks(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  home_id TEXT NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'cleaner' CHECK (role IN ('cleaner', 'member')),
  expires_at TEXT NOT NULL,
  used_by TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_visits_home_date ON visits(home_id, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_visit_tasks_visit ON visit_tasks(visit_id);
CREATE INDEX IF NOT EXISTS idx_questions_task ON task_questions(visit_task_id);

CREATE TABLE IF NOT EXISTS payment_methods (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  venmo_handle TEXT,
  zelle_contact TEXT,
  cashapp_handle TEXT,
  paypal_handle TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  visit_id TEXT REFERENCES visits(id) ON DELETE SET NULL,
  cleaner_id TEXT NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'paid', 'cancelled')),
  paid_via TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_invoices_home ON invoices(home_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_cleaner ON invoices(cleaner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS visit_feedback (
  id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  home_id TEXT NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  went_well TEXT NOT NULL DEFAULT '',
  needs_improvement TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_visit_feedback_home ON visit_feedback(home_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_visit_feedback_visit ON visit_feedback(visit_id);

CREATE TABLE IF NOT EXISTS cleaner_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  profile_photo_url TEXT,
  bio TEXT NOT NULL DEFAULT '',
  experience_years INTEGER,
  hourly_rate_cents INTEGER,
  minimum_visit_minutes INTEGER,
  minimum_visit_cents INTEGER,
  accepts_new_clients INTEGER NOT NULL DEFAULT 0,
  supplies_included INTEGER NOT NULL DEFAULT 0,
  brings_vacuum INTEGER NOT NULL DEFAULT 0,
  languages TEXT NOT NULL DEFAULT '[]',
  pet_comfort_level TEXT NOT NULL DEFAULT 'none' CHECK (
    pet_comfort_level IN ('none', 'cats', 'dogs', 'cats_and_dogs', 'all_pets')
  ),
  fragrance_free_available INTEGER NOT NULL DEFAULT 0,
  eco_friendly_products_available INTEGER NOT NULL DEFAULT 0,
  bleach_allowed INTEGER NOT NULL DEFAULT 1,
  deep_cleaning_available INTEGER NOT NULL DEFAULT 0,
  move_in_move_out_available INTEGER NOT NULL DEFAULT 0,
  recurring_cleaning_available INTEGER NOT NULL DEFAULT 1,
  one_time_cleaning_available INTEGER NOT NULL DEFAULT 1,
  profile_status TEXT NOT NULL DEFAULT 'draft' CHECK (
    profile_status IN ('draft', 'pending_review', 'approved', 'rejected', 'suspended')
  ),
  background_check_status TEXT NOT NULL DEFAULT 'not_provided' CHECK (
    background_check_status IN ('not_provided', 'pending', 'verified', 'failed')
  ),
  insurance_status TEXT NOT NULL DEFAULT 'not_provided' CHECK (
    insurance_status IN ('not_provided', 'pending', 'verified', 'expired')
  ),
  stripe_onboarding_status TEXT NOT NULL DEFAULT 'not_started' CHECK (
    stripe_onboarding_status IN ('not_started', 'pending', 'complete', 'restricted')
  ),
  admin_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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

CREATE TABLE IF NOT EXISTS cleaner_service_areas (
  id TEXT PRIMARY KEY,
  cleaner_profile_id TEXT NOT NULL REFERENCES cleaner_profiles(id) ON DELETE CASCADE,
  zip_code TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  radius_miles REAL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cleaner_availability (
  id TEXT PRIMARY KEY,
  cleaner_profile_id TEXT NOT NULL REFERENCES cleaner_profiles(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  is_available INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cleaning_requests (
  id TEXT PRIMARY KEY,
  homeowner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  household_id TEXT REFERENCES homes(id) ON DELETE SET NULL,
  zip_code TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  home_size_label TEXT NOT NULL DEFAULT '',
  bedrooms INTEGER,
  bathrooms REAL,
  square_feet INTEGER,
  frequency TEXT NOT NULL DEFAULT 'weekly' CHECK (
    frequency IN ('one_time', 'weekly', 'biweekly', 'monthly')
  ),
  preferred_days TEXT NOT NULL DEFAULT '[]',
  preferred_time_windows TEXT NOT NULL DEFAULT '[]',
  pets TEXT NOT NULL DEFAULT '',
  supplies_available INTEGER NOT NULL DEFAULT 0,
  homeowner_budget_min_cents INTEGER,
  homeowner_budget_max_cents INTEGER,
  estimated_minutes INTEGER NOT NULL DEFAULT 0,
  ai_preference_summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'open', 'proposals_received', 'proposal_accepted', 'cancelled', 'converted')
  ),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cleaning_request_tasks (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES cleaning_requests(id) ON DELETE CASCADE,
  room_name TEXT NOT NULL,
  task_name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  cadence TEXT NOT NULL CHECK (cadence IN ('weekly', 'monthly', 'quarterly')),
  estimated_minutes INTEGER NOT NULL DEFAULT 15,
  is_deep_clean INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cleaner_proposals (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES cleaning_requests(id) ON DELETE CASCADE,
  cleaner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cleaner_profile_id TEXT NOT NULL REFERENCES cleaner_profiles(id) ON DELETE CASCADE,
  hourly_rate_cents INTEGER NOT NULL,
  minimum_visit_minutes INTEGER,
  minimum_visit_cents INTEGER,
  first_visit_estimated_minutes INTEGER NOT NULL,
  first_visit_total_cents INTEGER NOT NULL,
  recurring_estimated_minutes INTEGER NOT NULL,
  recurring_total_cents INTEGER NOT NULL,
  supplies_included INTEGER NOT NULL DEFAULT 0,
  proposed_day INTEGER CHECK (proposed_day IS NULL OR (proposed_day >= 0 AND proposed_day <= 6)),
  proposed_start_time TEXT,
  proposed_end_time TEXT,
  message TEXT NOT NULL DEFAULT '',
  adjustment_reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'sent' CHECK (
    status IN ('sent', 'viewed', 'accepted', 'declined', 'withdrawn', 'expired')
  ),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (request_id, cleaner_id)
);

CREATE TABLE IF NOT EXISTS household_cleaner_agreements (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  homeowner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cleaner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accepted_proposal_id TEXT REFERENCES cleaner_proposals(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('byoc', 'match')),
  hourly_rate_cents INTEGER NOT NULL,
  recurring_estimated_minutes INTEGER NOT NULL,
  recurring_estimated_total_cents INTEGER NOT NULL,
  first_visit_estimated_minutes INTEGER,
  first_visit_estimated_total_cents INTEGER,
  agreed_frequency TEXT NOT NULL CHECK (
    agreed_frequency IN ('one_time', 'weekly', 'biweekly', 'monthly')
  ),
  agreed_day INTEGER CHECK (agreed_day IS NULL OR (agreed_day >= 0 AND agreed_day <= 6)),
  agreed_start_time TEXT,
  agreed_end_time TEXT,
  supplies_included INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scope_change_requests (
  id TEXT PRIMARY KEY,
  agreement_id TEXT NOT NULL REFERENCES household_cleaner_agreements(id) ON DELETE CASCADE,
  household_id TEXT NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_estimated_minutes INTEGER NOT NULL,
  new_estimated_minutes INTEGER NOT NULL,
  added_minutes INTEGER NOT NULL,
  old_estimated_total_cents INTEGER,
  new_estimated_total_cents INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'accepted', 'adjusted', 'declined', 'cancelled')
  ),
  cleaner_adjusted_minutes INTEGER,
  cleaner_adjusted_total_cents INTEGER,
  cleaner_message TEXT,
  homeowner_response TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admin_match_suggestions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES cleaning_requests(id) ON DELETE CASCADE,
  cleaner_profile_id TEXT NOT NULL REFERENCES cleaner_profiles(id) ON DELETE CASCADE,
  suggested_by_admin_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score REAL,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (
    status IN (
      'suggested',
      'sent_to_cleaner',
      'cleaner_accepted',
      'cleaner_declined',
      'homeowner_accepted',
      'homeowner_declined',
      'expired'
    )
  ),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cleaner_profiles_user ON cleaner_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_cleaner_profiles_status ON cleaner_profiles(profile_status);
CREATE INDEX IF NOT EXISTS idx_cleaner_languages_profile ON cleaner_languages(cleaner_profile_id);
CREATE INDEX IF NOT EXISTS idx_cleaner_services_profile ON cleaner_services(cleaner_profile_id);
CREATE INDEX IF NOT EXISTS idx_cleaner_service_areas_profile ON cleaner_service_areas(cleaner_profile_id);
CREATE INDEX IF NOT EXISTS idx_cleaner_service_areas_zip ON cleaner_service_areas(zip_code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cleaner_service_areas_profile_zip
  ON cleaner_service_areas(cleaner_profile_id, zip_code);
CREATE INDEX IF NOT EXISTS idx_cleaner_availability_profile ON cleaner_availability(cleaner_profile_id);
CREATE INDEX IF NOT EXISTS idx_cleaner_availability_profile_day
  ON cleaner_availability(cleaner_profile_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_cleaning_requests_homeowner ON cleaning_requests(homeowner_id);
CREATE INDEX IF NOT EXISTS idx_cleaning_requests_status ON cleaning_requests(status);
CREATE INDEX IF NOT EXISTS idx_cleaning_requests_zip ON cleaning_requests(zip_code);
CREATE INDEX IF NOT EXISTS idx_cleaning_request_tasks_request ON cleaning_request_tasks(request_id);
CREATE INDEX IF NOT EXISTS idx_cleaner_proposals_request ON cleaner_proposals(request_id);
CREATE INDEX IF NOT EXISTS idx_cleaner_proposals_cleaner ON cleaner_proposals(cleaner_id);
CREATE INDEX IF NOT EXISTS idx_cleaner_proposals_status ON cleaner_proposals(status);
CREATE TABLE IF NOT EXISTS payment_intents (
  id TEXT PRIMARY KEY,
  stripe_payment_intent_id TEXT UNIQUE,
  invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
  agreement_id TEXT REFERENCES household_cleaner_agreements(id) ON DELETE SET NULL,
  homeowner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cleaner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cleaner_amount_cents INTEGER NOT NULL,
  bradley_fee_cents INTEGER NOT NULL,
  total_amount_cents INTEGER NOT NULL,
  fee_type TEXT NOT NULL CHECK (fee_type IN ('byoc_platform_fee', 'match_fee')),
  fee_percent INTEGER NOT NULL CHECK (fee_percent IN (5, 10)),
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'requires_payment_method' CHECK (
    status IN (
      'requires_payment_method',
      'requires_confirmation',
      'processing',
      'succeeded',
      'failed',
      'canceled'
    )
  ),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS platform_fees (
  id TEXT PRIMARY KEY,
  payment_intent_id TEXT REFERENCES payment_intents(id) ON DELETE SET NULL,
  invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
  agreement_id TEXT REFERENCES household_cleaner_agreements(id) ON DELETE SET NULL,
  fee_type TEXT NOT NULL CHECK (fee_type IN ('byoc_platform_fee', 'match_fee')),
  fee_percent INTEGER NOT NULL CHECK (fee_percent IN (5, 10)),
  cleaner_amount_cents INTEGER NOT NULL,
  fee_amount_cents INTEGER NOT NULL,
  total_amount_cents INTEGER NOT NULL,
  stripe_fee_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payment_intents_invoice ON payment_intents(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_stripe ON payment_intents(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_platform_fees_payment_intent ON platform_fees(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_platform_fees_invoice ON platform_fees(invoice_id);

CREATE INDEX IF NOT EXISTS idx_household_cleaner_agreements_household ON household_cleaner_agreements(household_id);
CREATE INDEX IF NOT EXISTS idx_household_cleaner_agreements_cleaner ON household_cleaner_agreements(cleaner_id);
CREATE INDEX IF NOT EXISTS idx_household_cleaner_agreements_status ON household_cleaner_agreements(status);
CREATE INDEX IF NOT EXISTS idx_scope_change_requests_agreement ON scope_change_requests(agreement_id);
CREATE INDEX IF NOT EXISTS idx_scope_change_requests_status ON scope_change_requests(status);
CREATE INDEX IF NOT EXISTS idx_admin_match_suggestions_request ON admin_match_suggestions(request_id);
CREATE INDEX IF NOT EXISTS idx_admin_match_suggestions_status ON admin_match_suggestions(status);
