#!/usr/bin/env node
/**
 * Phase 1 marketplace E2E smoke test (local API).
 * Usage: node scripts/smoke-marketplace.mjs [baseUrl]
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const BASE = process.argv[2] || 'http://127.0.0.1:3847';
const ts = Date.now();
const clientEmail = `smoke-client-${ts}@test.local`;
const cleanerEmail = `smoke-cleaner-${ts}@test.local`;
const adminEmail = `smoke-admin-${ts}@test.local`;
const password = 'smoke-test-pass';

let serverProc = null;
let tmpDir = null;
let dbPath = null;
let startedServer = false;
let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✓ ${label}`);
  passed += 1;
}

function fail(label, detail) {
  console.error(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
  failed += 1;
}

async function req(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const msg = data.error || data.message || text.slice(0, 200);
    throw new Error(`${method} ${path} → ${res.status}: ${msg}`);
  }
  return data;
}

async function register(email, role, displayName) {
  const data = await req('/auth/register', {
    method: 'POST',
    body: { email, password, displayName, role },
  });
  return data.token;
}

function startLocalServer() {
  tmpDir = mkdtempSync(join(tmpdir(), 'bradley-smoke-'));
  dbPath = join(tmpDir, 'smoke.db');
  serverProc = spawn('node', ['index.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: '3847',
      BRADLEY_DB_PATH: dbPath,
      ADMIN_EMAILS: adminEmail,
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  startedServer = true;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timeout')), 15000);
    const check = async () => {
      try {
        const h = await fetch(`${BASE}/health`);
        if (h.ok) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(check, 200);
        }
      } catch {
        setTimeout(check, 200);
      }
    };
    serverProc.on('error', reject);
    setTimeout(check, 400);
  });
}

async function cleanup() {
  if (serverProc) {
    serverProc.kill('SIGTERM');
    serverProc = null;
  }
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function run() {
  console.log(`\nBradley Phase 1 smoke test → ${BASE}\n`);

  if (BASE.includes('127.0.0.1') || BASE.includes('localhost')) {
    try {
      await fetch(`${BASE}/health`);
    } catch {
      console.log('Starting local server with temp DB…');
      await startLocalServer();
      ok('Local server started');
    }
  }

  await req('/health');
  ok('Health check');

  const clientToken = await register(clientEmail, 'client', 'Smoke Client');
  ok('Register homeowner');

  const cleanerToken = await register(cleanerEmail, 'cleaner', 'Smoke Cleaner');
  ok('Register cleaner');

  const request = await req('/cleaning-requests', {
    method: 'POST',
    token: clientToken,
    body: {
      zip_code: '90210',
      city: 'Beverly Hills',
      state: 'CA',
      bedrooms: 3,
      bathrooms: 2,
      frequency: 'weekly',
      preferred_days: JSON.stringify([2]),
      preferred_time_windows: JSON.stringify(['morning']),
      tasks: [
        {
          room_name: 'Kitchen',
          task_name: 'Counters',
          cadence: 'weekly',
          estimated_minutes: 20,
          sort_order: 0,
        },
        {
          room_name: 'Bathroom',
          task_name: 'Shower',
          cadence: 'weekly',
          estimated_minutes: 30,
          sort_order: 1,
        },
      ],
    },
  });
  const minutes = request.total_estimated_minutes ?? request.estimated_minutes;
  if (!request.id || minutes !== 50) {
    fail('Create cleaning request', `id=${request.id} minutes=${minutes}`);
  } else {
    ok(`Create cleaning request (${minutes} min)`);
  }

  const profile = await req('/cleaner/profile', {
    method: 'POST',
    token: cleanerToken,
    body: {
      display_name: 'Smoke Cleaner',
      experience_years: 5,
      hourly_rate_cents: 4500,
      minimum_visit_minutes: 60,
      accepts_new_clients: true,
      supplies_included: false,
    },
  });
  ok('Create cleaner profile');

  const adminToken = await register(adminEmail, 'client', 'Smoke Admin');
  await req(`/admin/cleaner-profiles/${profile.id}/status`, {
    method: 'PATCH',
    token: adminToken,
    body: { profile_status: 'approved' },
  });
  ok('Approve cleaner profile (admin API)');

  await req('/cleaner/service-areas', {
    method: 'POST',
    token: cleanerToken,
    body: { zip_code: '90210', city: 'Beverly Hills', state: 'CA' },
  });
  ok('Add service area');

  await req('/cleaner/availability', {
    method: 'POST',
    token: cleanerToken,
    body: { day_of_week: 2, start_time: '09:00', end_time: '12:00' },
  });
  ok('Add availability');

  const { requests } = await req('/cleaner/available-requests', { token: cleanerToken });
  if (!requests.some((r) => r.id === request.id)) {
    fail('Cleaner sees request in ZIP');
  } else {
    ok('Cleaner sees open request (ZIP match)');
  }

  const proposal = await req(`/cleaning-requests/${request.id}/proposals`, {
    method: 'POST',
    token: cleanerToken,
    body: {
      hourly_rate_cents: 4500,
      first_visit_estimated_minutes: 80,
      recurring_estimated_minutes: 50,
      supplies_included: false,
      proposed_day: 2,
      proposed_start_time: '09:00',
      proposed_end_time: '12:00',
      message: 'Happy to help!',
    },
  });
  if (!proposal.first_visit_total_cents || !proposal.recurring_total_cents) {
    fail('Send proposal', 'missing estimate totals');
  } else {
    ok('Cleaner sends proposal (first + recurring)');
  }

  const { proposals } = await req(`/cleaning-requests/${request.id}/proposals`, {
    token: clientToken,
  });
  if (!proposals.length) fail('Homeowner lists proposals');
  else ok('Homeowner views proposals');

  const accept = await req(`/cleaner-proposals/${proposal.id}/accept`, {
    method: 'POST',
    token: clientToken,
  });
  if (!accept.id || !accept.household_id) {
    fail('Accept proposal → agreement', JSON.stringify(accept).slice(0, 120));
  } else {
    ok('Accept proposal → agreement + household');
  }

  const home = await req('/homes/mine', { token: clientToken });
  if (!home?.id) fail('Homeowner has household after accept');
  else ok('Homeowner household exists');

  const cleanerHome = await req('/homes/mine', { token: cleanerToken });
  if (!cleanerHome?.id) fail('Cleaner linked to household');
  else ok('Cleaner linked to household');

  // BYOC invite join (code path)
  const owner2Email = `smoke-owner2-${ts}@test.local`;
  const cleaner2Email = `smoke-cleaner2-${ts}@test.local`;
  const owner2Token = await register(owner2Email, 'client', 'BYOC Owner');
  const cleaner2Token = await register(cleaner2Email, 'cleaner', 'BYOC Cleaner');

  const byocHome = await req('/homes', {
    method: 'POST',
    token: owner2Token,
    body: { name: 'BYOC Home', visitDay: 3, visitTime: '10:00' },
  });
  const invite = await req(`/homes/${byocHome.id}/invite`, {
    method: 'POST',
    token: owner2Token,
    body: { inviteRole: 'cleaner' },
  });
  const joined = await req('/invites/join', {
    method: 'POST',
    token: cleaner2Token,
    body: { code: invite.code },
  });
  if (joined.id !== byocHome.id) fail('BYOC invite join');
  else ok('BYOC invite join unchanged');

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (err) => {
  console.error('\nSmoke test error:', err.message);
  await cleanup();
  process.exit(1);
});
