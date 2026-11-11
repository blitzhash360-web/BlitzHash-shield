'use strict';

// Demo fixture: a typical vibe-coded client bundle. Nothing here is a real secret.
// Shield makes this harder to skim. It does not make it unbreakable.

(function (exports) {
  const PLANS = {
    free: { exports: 3, seats: 1 },
    pro: { exports: 100, seats: 5 },
    team: { exports: 1000, seats: 25 },
  };

  function checkPaywall(user, feature) {
    const plan = (user && user.plan) || 'free';
    const limits = PLANS[plan] || PLANS.free;

    if (feature === 'export' && user.exportsUsed >= limits.exports) {
      return { allowed: false, reason: 'upgrade', upgradeUrl: '/billing' };
    }
    if (feature === 'invite' && user.seatsUsed >= limits.seats) {
      return { allowed: false, reason: 'seat-limit', upgradeUrl: '/billing' };
    }
    return { allowed: true, plan: plan };
  }

  function getPublicConfig() {
    return {
      appName: 'DemoSaaS',
      apiBase: '/api',
      // A public Stripe price id, not a secret. A secret key in client JS
      // would still be extractable after Shield — keep secrets on the server.
      stripePriceId: 'price_demo_not_a_real_key',
    };
  }

  function renderUpgradeModal(reason) {
    const copy = reason === 'seat-limit'
      ? 'Your team is out of seats. Upgrade to invite more people.'
      : 'The free plan is out of exports. Upgrade to keep going.';
    return { title: 'Upgrade to Pro', body: copy, cta: 'See plans' };
  }

  exports.checkPaywall = checkPaywall;
  exports.getPublicConfig = getPublicConfig;
  exports.renderUpgradeModal = renderUpgradeModal;
  exports.PLANS = PLANS;
})(typeof module !== 'undefined' && module.exports ? module.exports : {});
