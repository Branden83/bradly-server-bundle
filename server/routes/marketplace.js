import { ServiceError } from '../lib/serviceError.js';
import * as cleanerProfileService from '../services/cleanerProfileService.js';
import * as cleaningRequestService from '../services/cleaningRequestService.js';
import * as proposalService from '../services/proposalService.js';
import * as agreementService from '../services/agreementService.js';
import * as matchingService from '../services/matchingService.js';
import { formatCleanerProfileRow } from '../lib/marketplaceFormat.js';

function handleServiceError(err, res) {
  if (err instanceof ServiceError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error('[marketplace]', err);
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

function requireClient(req, res) {
  if (req.user.role !== 'client') {
    res.status(403).json({ error: 'Homeowner access required' });
    return false;
  }
  return true;
}

function requireCleaner(req, res) {
  if (req.user.role !== 'cleaner') {
    res.status(403).json({ error: 'Cleaner access required' });
    return false;
  }
  return true;
}

export function registerMarketplaceRoutes(app, { auth, authRequired, requireAdmin }) {
  // ─── Homeowner: cleaning requests ─────────────────────────────────────────

  app.post(
    '/cleaning-requests',
    authRequired,
    wrap((req, res) => {
      if (!requireClient(req, res)) return;
      const request = cleaningRequestService.createRequest(req.user.id, req.body);
      res.status(201).json(request);
    })
  );

  app.get(
    '/cleaning-requests/me',
    authRequired,
    wrap((req, res) => {
      if (!requireClient(req, res)) return;
      res.json({ requests: cleaningRequestService.listRequestsForHomeowner(req.user.id) });
    })
  );

  app.get(
    '/cleaning-requests/:id',
    authRequired,
    wrap((req, res) => {
      if (req.user.role === 'client') {
        const request = cleaningRequestService.getRequestForHomeowner(req.params.id, req.user.id);
        return res.json(request);
      }
      if (req.user.role === 'cleaner') {
        const request = cleaningRequestService.getRequestForCleaner(req.params.id, req.user.id);
        return res.json(request);
      }
      return res.status(403).json({ error: 'Not allowed' });
    })
  );

  app.patch(
    '/cleaning-requests/:id',
    authRequired,
    wrap((req, res) => {
      if (!requireClient(req, res)) return;
      const request = cleaningRequestService.updateRequest(req.params.id, req.user.id, req.body);
      res.json(request);
    })
  );

  app.patch(
    '/cleaning-requests/:id/cancel',
    authRequired,
    wrap((req, res) => {
      if (!requireClient(req, res)) return;
      const request = cleaningRequestService.cancelRequest(req.params.id, req.user.id);
      res.json(request);
    })
  );

  app.post(
    '/cleaning-requests/:id/tasks',
    authRequired,
    wrap((req, res) => {
      if (!requireClient(req, res)) return;
      const task = cleaningRequestService.addRequestTask(req.params.id, req.user.id, req.body);
      res.status(201).json(task);
    })
  );

  app.patch(
    '/cleaning-request-tasks/:id',
    authRequired,
    wrap((req, res) => {
      if (!requireClient(req, res)) return;
      const task = cleaningRequestService.updateRequestTask(req.params.id, req.user.id, req.body);
      res.json(task);
    })
  );

  app.delete(
    '/cleaning-request-tasks/:id',
    authRequired,
    wrap((req, res) => {
      if (!requireClient(req, res)) return;
      const result = cleaningRequestService.removeRequestTask(req.params.id, req.user.id);
      res.json(result);
    })
  );

  app.get(
    '/cleaning-requests/:id/proposals',
    authRequired,
    wrap((req, res) => {
      if (!requireClient(req, res)) return;
      const sort = req.query.sort === 'lowest_estimate' ? 'lowest_estimate' : 'best_match';
      const proposals = proposalService.listProposalsForHomeowner(
        req.params.id,
        req.user.id,
        { sort }
      );
      res.json({ proposals });
    })
  );

  app.post(
    '/cleaner-proposals/:id/accept',
    authRequired,
    wrap((req, res) => {
      if (!requireClient(req, res)) return;
      const agreement = agreementService.createFromAcceptedProposal(req.params.id, req.user.id);
      res.json(agreement);
    })
  );

  app.post(
    '/cleaner-proposals/:id/decline',
    authRequired,
    wrap((req, res) => {
      if (!requireClient(req, res)) return;
      const proposal = proposalService.declineProposal(req.params.id, req.user.id);
      res.json(proposal);
    })
  );

  app.get(
    '/cleaner-proposals/:id',
    authRequired,
    wrap((req, res) => {
      if (req.user.role === 'client') {
        const proposal = proposalService.getProposalById(req.params.id);
        cleaningRequestService.getRequestForHomeowner(proposal.request_id, req.user.id);
        return res.json(proposal);
      }
      if (req.user.role === 'cleaner') {
        const proposal = proposalService.getProposalForCleaner(req.params.id, req.user.id);
        return res.json(proposal);
      }
      return res.status(403).json({ error: 'Not allowed' });
    })
  );

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

  app.post(
    '/cleaner/service-areas',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const area = cleanerProfileService.addServiceArea(req.user.id, req.body);
      res.status(201).json(area);
    })
  );

  app.delete(
    '/cleaner/service-areas/:id',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const result = cleanerProfileService.removeServiceArea(req.user.id, req.params.id);
      res.json(result);
    })
  );

  app.get(
    '/cleaner/service-areas',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      res.json({ areas: cleanerProfileService.listServiceAreas(req.user.id) });
    })
  );

  app.post(
    '/cleaner/availability',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const slot = cleanerProfileService.addAvailability(req.user.id, req.body);
      res.status(201).json(slot);
    })
  );

  app.patch(
    '/cleaner/availability/:id',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const slot = cleanerProfileService.updateAvailability(req.user.id, req.params.id, req.body);
      res.json(slot);
    })
  );

  app.get(
    '/cleaner/availability',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      res.json({ slots: cleanerProfileService.listAvailability(req.user.id) });
    })
  );

  app.get(
    '/cleaner/available-requests',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const requests = cleaningRequestService.listAvailableRequestsForCleaner(req.user.id);
      res.json({ requests });
    })
  );

  app.get(
    '/cleaner/cleaning-requests/:id',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const request = cleaningRequestService.getRequestForCleaner(req.params.id, req.user.id);
      res.json(request);
    })
  );

  app.post(
    '/cleaning-requests/:id/proposals',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const proposal = proposalService.sendProposal(req.params.id, req.user.id, req.body);
      res.status(201).json(proposal);
    })
  );

  app.patch(
    '/cleaner-proposals/:id',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const proposal = proposalService.updateProposal(req.params.id, req.user.id, req.body);
      res.json(proposal);
    })
  );

  app.post(
    '/cleaner-proposals/:id/withdraw',
    auth,
    wrap((req, res) => {
      if (!requireCleaner(req, res)) return;
      const proposal = proposalService.withdrawProposal(req.params.id, req.user.id);
      res.json(proposal);
    })
  );

  // ─── Agreements ───────────────────────────────────────────────────────────

  app.get(
    '/agreements/me',
    authRequired,
    wrap((req, res) => {
      const agreements = agreementService.listAgreementsForUser(req.user.id, req.user.role);
      res.json({ agreements });
    })
  );

  app.get(
    '/agreements/:id',
    authRequired,
    wrap((req, res) => {
      const agreement = agreementService.getAgreementForUser(req.params.id, req.user.id);
      res.json(agreement);
    })
  );

  // ─── Admin: marketplace ───────────────────────────────────────────────────

  app.get(
    '/admin/cleaning-requests',
    authRequired,
    requireAdmin,
    wrap((_req, res) => {
      res.json({ requests: cleaningRequestService.listRequestsForAdmin() });
    })
  );

  app.get(
    '/admin/cleaning-requests/:id',
    authRequired,
    requireAdmin,
    wrap((req, res) => {
      const request = cleaningRequestService.getRequestForAdmin(req.params.id);
      res.json({ request });
    })
  );

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
        profiles: rows.map((row) => formatCleanerProfileRow(row, { serviceAreas: [], availability: [] })),
      });
    })
  );

  app.get(
    '/admin/cleaner-profiles/:id',
    authRequired,
    requireAdmin,
    wrap((req, res) => {
      const profile = cleanerProfileService.getProfileById(req.params.id);
      if (!profile) return res.status(404).json({ error: 'Profile not found' });
      res.json({ profile });
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

  app.get(
    '/admin/match-suggestions',
    authRequired,
    requireAdmin,
    wrap((req, res) => {
      const suggestions = matchingService.listMatchSuggestions(req.query.requestId || null);
      res.json({ suggestions });
    })
  );

  app.post(
    '/admin/cleaning-requests/:id/suggest-cleaners',
    authRequired,
    requireAdmin,
    wrap((req, res) => {
      const result = matchingService.suggestCleanersForRequest(req.params.id, req.user.id);
      res.status(201).json(result);
    })
  );

  app.post(
    '/admin/cleaning-requests/:id/manual-suggestion',
    authRequired,
    requireAdmin,
    wrap((req, res) => {
      const suggestion = matchingService.manualSuggestion(req.params.id, req.user.id, req.body);
      res.status(201).json(suggestion);
    })
  );
}
