import db from '../db.js';
import { ServiceError } from '../lib/serviceError.js';
import * as cleanerProfileService from '../services/cleanerProfileService.js';
import * as cleanerLanguageService from '../services/cleanerLanguageService.js';
import * as cleanerServiceAreaService from '../services/cleanerServiceAreaService.js';
import * as cleanerAvailabilityService from '../services/cleanerAvailabilityService.js';
import * as cleanerServicesService from '../services/cleanerServicesService.js';
import * as profileCompletionService from '../services/profileCompletionService.js';
import * as stripeConnectService from '../services/stripeConnectService.js';

function handleServiceError(err, res) {
  if (err instanceof ServiceError) {
    const payload = { error: err.message };
    if (err.code) payload.code = err.code;
    return res.status(err.status).json(payload);
  }
  console.error('[cleanerProfile]', err);
  return res.status(500).json({ error: 'Something went wrong' });
}

function wrap(handler) {
  return (req, res) => {
    try {
      handler(req, res);
    } catch (err) {
      handleServiceError(err, res);
    }
  };
}

function requireCleaner(req, res) {
  if (req.user.role !== 'cleaner') {
    res.status(403).json({ error: 'Cleaner access required' });
    return false;
  }
  return true;
}

function formatAdminListRow(row) {
  const profile = cleanerProfileService.getProfileById(row.id, { includeAdminNotes: true });
  return {
    ...profile,
    user_email: row.email,
  };
}

export function registerCleanerProfileRoutes(app, { auth, authRequired, requireAdmin }) {
  // ─── Cleaner: profile ─────────────────────────────────────────────────────

  app.get(
    '/cleaner/profile',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const profile = cleanerProfileService.getProfileByUserId(req.user.id);
      if (!profile) return res.status(404).json({ error: 'Profile not found' });
      res.json(profile);
    })
  );

  app.post(
    '/cleaner/profile',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const profile = cleanerProfileService.createProfile(req.user.id, req.body);
      res.status(201).json(profile);
    })
  );

  app.patch(
    '/cleaner/profile',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const profile = cleanerProfileService.updateProfile(req.user.id, req.body);
      res.json(profile);
    })
  );

  app.get(
    '/cleaner/profile/completion',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const completion = profileCompletionService.getProfileCompletion(req.user.id);
      res.json(completion);
    })
  );

  // ─── Cleaner: languages ─────────────────────────────────────────────────────

  app.post(
    '/cleaner/languages',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const language = cleanerLanguageService.addLanguage(req.user.id, req.body);
      res.status(201).json(language);
    })
  );

  app.patch(
    '/cleaner/languages/:id',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const language = cleanerLanguageService.updateLanguage(req.user.id, req.params.id, req.body);
      res.json(language);
    })
  );

  app.delete(
    '/cleaner/languages/:id',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const result = cleanerLanguageService.deleteLanguage(req.user.id, req.params.id);
      res.json(result);
    })
  );

  // ─── Cleaner: service areas ─────────────────────────────────────────────────

  app.post(
    '/cleaner/service-areas',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const area = cleanerServiceAreaService.addServiceArea(req.user.id, req.body);
      res.status(201).json(area);
    })
  );

  app.patch(
    '/cleaner/service-areas/:id',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const area = cleanerServiceAreaService.updateServiceArea(req.user.id, req.params.id, req.body);
      res.json(area);
    })
  );

  app.delete(
    '/cleaner/service-areas/:id',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const result = cleanerServiceAreaService.removeServiceArea(req.user.id, req.params.id);
      res.json(result);
    })
  );

  // Back-compat list (also embedded on GET /cleaner/profile)
  app.get(
    '/cleaner/service-areas',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      res.json({ areas: cleanerServiceAreaService.listServiceAreas(req.user.id) });
    })
  );

  // ─── Cleaner: availability ────────────────────────────────────────────────

  app.post(
    '/cleaner/availability',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const slot = cleanerAvailabilityService.addAvailability(req.user.id, req.body);
      res.status(201).json(slot);
    })
  );

  app.patch(
    '/cleaner/availability/:id',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const slot = cleanerAvailabilityService.updateAvailability(
        req.user.id,
        req.params.id,
        req.body
      );
      res.json(slot);
    })
  );

  app.delete(
    '/cleaner/availability/:id',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const result = cleanerAvailabilityService.deleteAvailability(req.user.id, req.params.id);
      res.json(result);
    })
  );

  app.get(
    '/cleaner/availability',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      res.json({ slots: cleanerAvailabilityService.listAvailability(req.user.id) });
    })
  );

  // ─── Cleaner: offered services ────────────────────────────────────────────

  app.post(
    '/cleaner/services',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const service = cleanerServicesService.upsertService(req.user.id, req.body);
      res.status(201).json(service);
    })
  );

  app.patch(
    '/cleaner/services/:id',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const service = cleanerServicesService.updateService(req.user.id, req.params.id, req.body);
      res.json(service);
    })
  );

  app.delete(
    '/cleaner/services/:id',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const result = cleanerServicesService.deleteService(req.user.id, req.params.id);
      res.json(result);
    })
  );

  // ─── Cleaner: Stripe Connect ──────────────────────────────────────────────

  app.post(
    '/payments/connect/account',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const account = stripeConnectService.createConnectAccount(req.user.id, req.body);
      res.status(account.already_exists ? 200 : 201).json(account);
    })
  );

  app.post(
    '/payments/connect/onboarding-link',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const link = stripeConnectService.createOnboardingLink(req.user.id, {
        returnUrl: req.body.returnUrl ?? req.body.return_url,
        refreshUrl: req.body.refreshUrl ?? req.body.refresh_url,
      });
      res.json(link);
    })
  );

  app.get(
    '/payments/connect/status',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      res.json(stripeConnectService.getConnectAccountStatus(req.user.id));
    })
  );

  // ─── Admin: cleaner profiles ──────────────────────────────────────────────

  app.get(
    '/admin/cleaner-profiles',
    authRequired,
    requireAdmin,
    wrap((req, res) => {
      const rows = cleanerProfileService.listProfilesForAdmin({
        status: req.query.status,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.json({
        profiles: rows.map(formatAdminListRow),
      });
    })
  );

  app.get(
    '/admin/cleaner-profiles/:id',
    authRequired,
    requireAdmin,
    wrap((req, res) => {
      const profile = cleanerProfileService.getProfileById(req.params.id, { includeAdminNotes: true });
      if (!profile) return res.status(404).json({ error: 'Profile not found' });

      const user = userEmail(profile.user_id);
      const completion = profileCompletionService.getProfileCompletionByProfileId(req.params.id);

      res.json({
        profile: {
          ...profile,
          user_email: user?.email ?? null,
        },
        completion,
        connect: stripeConnectService.getCleanerConnectStatus(profile.user_id),
      });
    })
  );

  app.patch(
    '/admin/cleaner-profiles/:id/status',
    authRequired,
    requireAdmin,
    wrap((req, res) => {
      const profile = cleanerProfileService.updateProfileStatus(
        req.params.id,
        req.body.profileStatus ?? req.body.profile_status ?? req.body.status,
        req.body.adminNotes ?? req.body.admin_notes
      );
      res.json({ profile });
    })
  );

  app.patch(
    '/admin/cleaner-profiles/:id/admin-notes',
    authRequired,
    requireAdmin,
    wrap((req, res) => {
      const adminNotes = req.body.adminNotes ?? req.body.admin_notes;
      if (adminNotes == null) {
        return res.status(400).json({ error: 'adminNotes is required' });
      }
      const profile = cleanerProfileService.updateAdminNotes(req.params.id, adminNotes);
      res.json({ profile });
    })
  );
}

function userEmail(userId) {
  return db.prepare('SELECT email FROM users WHERE id = ?').get(userId) ?? null;
}
