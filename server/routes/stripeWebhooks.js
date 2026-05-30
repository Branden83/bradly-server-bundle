import express from 'express';
import { handleStripeWebhookRequest } from '../services/stripeWebhookService.js';

/**
 * Register Stripe webhook route before express.json() middleware.
 * @param {import('express').Express} app
 */
export function registerStripeWebhookRoutes(app) {
  app.post(
    '/webhooks/stripe',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
      try {
        const result = await handleStripeWebhookRequest(req);
        res.json(result);
      } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error('[stripe webhook]', err);
        res.status(status).json({ error: err.message || 'Webhook handler failed' });
      }
    }
  );
}
