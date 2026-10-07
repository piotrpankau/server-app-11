'use strict';
/* Hosting plans and add-ons for client game servers.
   Defaults live here; config.json may override them under `plans` / `addons`.
   A server without a plan (admin's own) has no limits. */

const DEFAULT_PLANS = {
  start: { label: 'Start', memoryMb: 2500, cpuQuota: 150, backups: 3, schedule: false, autoBackup: false, crossplay: false },
  plus: { label: 'Plus', memoryMb: 3500, cpuQuota: 200, backups: 10, schedule: true, autoBackup: true, crossplay: true }
};

// Add-ons are bought one by one. `backups` adds slots, the rest are feature flags.
const DEFAULT_ADDONS = {
  backups10: { label: '+10 kopii zapasowych', backups: 10 },
  discord: { label: 'Powiadomienia na Discordzie (webhook)' },
  world2: { label: 'Drugi świat (zachowanie starego przy resecie)' }
};

const GRACE_DAYS = 3;
const DAY = 86400000;

function plans(cfg) { return Object.assign({}, DEFAULT_PLANS, (cfg && cfg.plans) || {}); }
function addons(cfg) { return Object.assign({}, DEFAULT_ADDONS, (cfg && cfg.addons) || {}); }

// Effective limits and feature flags of one server.
function limitsFor(cfg, s) {
  const plan = s.plan ? plans(cfg)[s.plan] : null;
  const ad = addons(cfg);
  const has = (k) => (s.addons || []).includes(k) && !!ad[k];
  if (!plan) {
    return { plan: null, planLabel: null, memoryMb: null, cpuQuota: null, backups: null, schedule: true, autoBackup: true, crossplay: true, discord: true, world2: true };
  }
  let backups = plan.backups;
  for (const k of s.addons || []) if (ad[k] && ad[k].backups) backups += ad[k].backups;
  return {
    plan: s.plan, planLabel: plan.label, memoryMb: plan.memoryMb, cpuQuota: plan.cpuQuota || null, backups,
    schedule: !!plan.schedule, autoBackup: !!plan.autoBackup, crossplay: !!plan.crossplay,
    discord: has('discord'), world2: has('world2')
  };
}

// 'none' = no expiry set, 'ok', 'warn' (< 5 days left), 'grace' (expired, still running), 'expired' (blocked).
function paidState(s, now = Date.now()) {
  if (!s.paidUntil) return { state: 'none', until: null, daysLeft: null };
  const left = s.paidUntil - now;
  const daysLeft = Math.ceil(left / DAY);
  let state = 'ok';
  if (left <= 0) state = now > s.paidUntil + GRACE_DAYS * DAY ? 'expired' : 'grace';
  else if (daysLeft <= 5) state = 'warn';
  return { state, until: s.paidUntil, daysLeft, graceDays: GRACE_DAYS };
}

module.exports = { plans, addons, limitsFor, paidState, GRACE_DAYS };
