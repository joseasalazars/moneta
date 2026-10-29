// Passkey unlock (WebAuthn) on localhost, with no dependencies. The browser or phone runs the fingerprint/face/PIN check;
// the server only verifies that the response is signed by the key registered once, for this exact challenge, origin
// and site, with user verification (fingerprint, face or PIN) actually performed. Self-check: node auth.js
import { createHash, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

export const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (b) => createHash('sha256').update(b).digest();
export const ALGS = [-7, -257]; // ES256, RS256: what Apple's platform authenticator and Chrome hand out

// Checks shared by registration (type webauthn.create) and unlock (webauthn.get). Returns the signature counter.
export function checkCeremony({ clientDataJSON, authenticatorData, type, challenge, origins, rpId }) {
  const client = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8'));
  if (client.type !== type) throw new Error('wrong ceremony type');
  if (client.challenge !== challenge) throw new Error('stale or forged challenge');
  if (!origins.includes(client.origin)) throw new Error(`unexpected origin ${client.origin}`);
  const auth = Buffer.from(authenticatorData, 'base64url');
  if (auth.length < 37 || !auth.subarray(0, 32).equals(sha256(rpId))) throw new Error('wrong relying party');
  const flags = auth[32];
  if (!(flags & 0x01) || !(flags & 0x04)) throw new Error('the passkey must verify you (fingerprint, face or PIN)');
  return auth.readUInt32BE(33);
}

// The signature covers authenticatorData followed by SHA-256(clientDataJSON). publicKey is SPKI DER, base64url.
export function verifyAssertion({ publicKey, clientDataJSON, authenticatorData, signature }) {
  const data = Buffer.concat([Buffer.from(authenticatorData, 'base64url'), sha256(Buffer.from(clientDataJSON, 'base64url'))]);
  return verify('sha256', data, { key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' }, Buffer.from(signature, 'base64url'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import('node:assert/strict')).default;
  const rpId = 'localhost', origins = ['http://localhost:3000'], challenge = b64url(randomBytes(32));
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = b64url(publicKey.export({ format: 'der', type: 'spki' }));
  const authData = (flags, counter = 0) => b64url(Buffer.concat([sha256(rpId), Buffer.from([flags]), Buffer.from([0, 0, 0, counter])]));
  const client = (over = {}) => b64url(JSON.stringify({ type: 'webauthn.get', challenge, origin: origins[0], ...over }));
  const signed = (cd, ad) => b64url(sign('sha256', Buffer.concat([Buffer.from(ad, 'base64url'), sha256(Buffer.from(cd, 'base64url'))]), privateKey));

  const cd = client(), ad = authData(0x05, 7);
  assert.equal(checkCeremony({ clientDataJSON: cd, authenticatorData: ad, type: 'webauthn.get', challenge, origins, rpId }), 7);
  assert.ok(verifyAssertion({ publicKey: spki, clientDataJSON: cd, authenticatorData: ad, signature: signed(cd, ad) }));
  assert.ok(!verifyAssertion({ publicKey: spki, clientDataJSON: client({ challenge: 'x' }), authenticatorData: ad, signature: signed(cd, ad) }), 'tampered data fails');
  const other = b64url(generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'der', type: 'spki' }));
  assert.ok(!verifyAssertion({ publicKey: other, clientDataJSON: cd, authenticatorData: ad, signature: signed(cd, ad) }), 'another key fails');
  const bad = (over, msg) => assert.throws(() => checkCeremony({ clientDataJSON: cd, authenticatorData: ad, type: 'webauthn.get', challenge, origins, rpId, ...over }), msg);
  bad({ challenge: 'old' }, /challenge/);
  bad({ type: 'webauthn.create' }, /type/);
  bad({ origins: ['http://evil.test'] }, /origin/);
  bad({ rpId: 'evil.test' }, /relying party/);
  bad({ authenticatorData: authData(0x01) }, /verify you/); // presence without verification
  console.log('auth self-check ok');
}
