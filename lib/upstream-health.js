'use strict';

// Eligibility is read-only; only acquire() reserves a half-open probe.
function createHealth({ cooldownMs, failureThreshold, recoveryThreshold, now = Date.now }) {
  const states = new Map();
  const get = id => {
    if (!states.has(id)) states.set(id, { state: 'closed', failures: 0, recoveries: 0,
      openUntil: 0, probes: 0, generation: 0, lastOutcome: '', lastError: '', lastStatus: 0, updatedAt: 0 });
    return states.get(id);
  };
  const view = id => {
    const s = states.get(id);
    return s ? { ...s, state: s.state === 'open' && s.openUntil <= now() ? 'half-open' : s.state }
      : { state: 'closed', failures: 0, recoveries: 0, openUntil: 0, probes: 0,
        lastOutcome: '', lastError: '', lastStatus: 0, updatedAt: 0 };
  };
  const eligible = id => { const s = view(id); return s.state === 'closed' || (s.state === 'half-open' && s.probes === 0); };
  function acquire(id) {
    if (!eligible(id)) return null;
    const s = get(id);
    if (s.state === 'open') { s.state = 'half-open'; s.recoveries = 0; }
    const probe = s.state === 'half-open', generation = s.generation;
    if (probe) s.probes++;
    let released = false;
    return (outcome, error = '', status = 0) => {
      if (released) return;
      released = true;
      if (probe) s.probes--;
      // An older in-flight success cannot close a newly opened circuit.
      if (generation !== s.generation) return;
      s.lastOutcome = outcome; s.lastError = error; s.lastStatus = status; s.updatedAt = now();
      if (outcome === 'cancelled') return;
      if (outcome === 'success') {
        s.failures = 0;
        if (!probe || ++s.recoveries >= recoveryThreshold) {
          s.state = 'closed'; s.recoveries = 0; s.openUntil = 0;
        }
      } else if (outcome === 'failure') {
        s.failures++; s.recoveries = 0;
        if (probe || s.failures >= failureThreshold) {
          s.state = 'open'; s.openUntil = now() + cooldownMs; s.generation++;
        }
      } else {
        // Non-retryable HTTP errors prove reachability, not recovery.
        s.failures = 0; s.recoveries = 0;
      }
    };
  }
  return { view, eligible, acquire, reset: id => states.delete(id), clear: () => states.clear() };
}

module.exports = { createHealth };
