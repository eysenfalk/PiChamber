import { expect, test } from 'bun:test';
import { checkoutRevision, validateCheckout } from './checkout.mjs';

test('checkout.mjs validates host-supplied lab revision, including false dirty and incomplete metadata', () => {
  const commit = 'a'.repeat(40);
  expect(checkoutRevision('/not-mounted', { PROOF_COMMIT: commit, PROOF_DIRTY: 'false' })).toEqual({ commit, dirty: false });
  expect(checkoutRevision('/not-mounted', { PROOF_COMMIT: commit, PROOF_DIRTY: 'true' })).toEqual({ commit, dirty: true });
  for (const env of [{ PROOF_COMMIT: commit }, { PROOF_DIRTY: 'false' }, { PROOF_COMMIT: 'bad', PROOF_DIRTY: 'false' }]) expect(() => checkoutRevision('/not-mounted', env)).toThrow();
  expect(() => validateCheckout({ commit, dirty: 'false' })).toThrow();
});
