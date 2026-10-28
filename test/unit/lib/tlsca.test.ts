import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as tls from 'node:tls';
import { CERT_HELP, isCertChainError, trustedCa } from '../../../src/lib/tlsca';

test('trusted CAs: the default list plus the system store where Node can read it; certificate checks stay on', () => {
  const ca = trustedCa();
  const get = (tls as unknown as { getCACertificates?: (t: string) => string[] }).getCACertificates;
  if (typeof get !== 'function') {
    assert.equal(ca, undefined, 'older Node: keep its default');
    return;
  }
  assert.ok(Array.isArray(ca) && ca.length >= get('default').length);
  for (const c of get('system')) assert.ok(ca!.includes(c));
});

test('a company certificate in the chain is recognised and explained, without suggesting to turn checks off', () => {
  assert.equal(isCertChainError(Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })), true);
  assert.equal(isCertChainError(Object.assign(new Error('unable to get local issuer certificate'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })), true);
  assert.equal(isCertChainError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })), false);
  assert.match(CERT_HELP, /NODE_EXTRA_CA_CERTS/);
  assert.doesNotMatch(CERT_HELP, /NODE_TLS_REJECT_UNAUTHORIZED/);
});
