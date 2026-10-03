import { execFileSync } from 'node:child_process';

export function validateCheckout(checkout) {
  if (!checkout || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(checkout.commit) || typeof checkout.dirty !== 'boolean') throw new Error('Checkout commit and dirty flag required');
  return checkout;
}

// The lab controller supplies host metadata: its .git may live outside /repo.
export function checkoutRevision(cwd, env = process.env) {
  if (env.PROOF_COMMIT !== undefined || env.PROOF_DIRTY !== undefined) {
    if (!['true', 'false'].includes(env.PROOF_DIRTY)) throw new Error('Invalid PROOF_DIRTY');
    return validateCheckout({ commit: env.PROOF_COMMIT, dirty: env.PROOF_DIRTY === 'true' });
  }
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).trim();
  return validateCheckout({ commit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']) !== '' });
}
