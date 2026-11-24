const TRIAL_INSIGHT_PREFIX = 'trial:';

function insightConsentField(isTrial) {
  return isTrial ? 'trialAiConsent' : 'aiConsent';
}

function aiConsentRevision(settings, isTrial) {
  if (!settings || settings.deletedAt || !settings.data ||
      settings.data[insightConsentField(isTrial)] !== true) return 0;
  return settings.seq;
}

module.exports = { TRIAL_INSIGHT_PREFIX, insightConsentField, aiConsentRevision };
