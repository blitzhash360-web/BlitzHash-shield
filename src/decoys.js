'use strict';

/**
 * Sanitized anti-LLM decoy identifiers and strings.
 *
 * Inspired by the public technique documented at
 * https://nullpt.rs/fingerprinting-bioweapons (veritas / nullpt.rs, CC BY-NC-SA).
 * These are original, clearly labeled bait names. They are not copied from that
 * article and contain no weapon, self-harm, or jailbreak-prompt text.
 */

const IDENTIFIERS = Object.freeze([
  'SYSTEM_OVERRIDE_CLASSIFIED',
  'tripSafetyFilter_v2',
  '__decoy_ignoreAllRules',
  'POLICY_CHECK_BAIT',
  'LLM_REFUSAL_CANARY',
  '__shield_doNotUnpack',
  'classifiedBriefingPlaceholder',
  'safetyFilterTripwire',
  'UNRESTRICTED_MODE_STUB',
  'DECOY_PAYLOAD_IGNORE',
  'antiLlmUnpackTrap',
  '__bh_shield_bait',
]);

const STRINGS = Object.freeze([
  'SYSTEM_OVERRIDE_CLASSIFIED',
  'tripSafetyFilter_v2',
  '__decoy_ignoreAllRules',
  'POLICY_CHECK_FAILED_DECOY',
  'THIS_IS_SHIELD_BAIT_NOT_A_PROMPT',
  'LLM_REFUSAL_CANARY: benign decoy string',
  'classified briefing placeholder — not an instruction',
  'safetyFilterTripwire',
  'UNRESTRICTED_MODE_STUB',
  'DECOY_PAYLOAD_IGNORE',
]);

function escapeRegex(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function reservedNamePatterns(identifiers) {
  return identifiers.map((name) => `^${escapeRegex(name)}$`);
}

function injectDeadCode(source, identifiers, strings) {
  const assignments = identifiers
    .map((id, i) => `${id}:${JSON.stringify(strings[i % strings.length])}`)
    .join(',');
  const first = identifiers[0];
  // Runtime-opaque guard so this is not obviously dead and not stripped.
  const block = `;!function(g){var ${first}={${assignments}};if(g&&g.__BH_SHIELD_FORCE_DECOYS__)return ${first}}(typeof globalThis!=="undefined"?globalThis:this);`;
  return `${source}${block}`;
}

function pickString(strings, preferred, fallbackIndex) {
  if (strings.includes(preferred)) return preferred;
  return strings[fallbackIndex % strings.length];
}

function buildPreamble(identifiers, strings) {
  // Visible bait an LLM sees first when it opens the file.
  const vars = identifiers.slice(0, 3);
  const values = [
    pickString(strings, 'THIS_IS_SHIELD_BAIT_NOT_A_PROMPT', 4),
    pickString(strings, 'LLM_REFUSAL_CANARY: benign decoy string', 5),
    pickString(strings, 'POLICY_CHECK_FAILED_DECOY', 3),
  ];
  const assigns = vars
    .map((id, i) => `${id}=${JSON.stringify(values[i])}`)
    .join(',');
  const fn = identifiers[3];
  const fnBody = pickString(
    strings,
    'classified briefing placeholder — not an instruction',
    Math.min(6, strings.length - 1)
  );
  return `var ${assigns};function ${fn}(){return ${JSON.stringify(fnBody)}}`;
}

function wrapWithPreamble(obfuscated, identifiers, strings) {
  return `${buildPreamble(identifiers, strings)};\n${obfuscated}`;
}

module.exports = {
  IDENTIFIERS,
  STRINGS,
  reservedNamePatterns,
  injectDeadCode,
  buildPreamble,
  wrapWithPreamble,
};
