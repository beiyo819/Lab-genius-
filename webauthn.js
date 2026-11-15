/* Fingerprint / passkey (WebAuthn) checks using only Node's built-in crypto. */
const crypto = require('crypto');
const sha = b => crypto.createHash('sha256').update(b).digest();
const b64u = b => Buffer.from(b).toString('base64url'), unb64u = s => Buffer.from(String(s), 'base64url');
function cbor(buf, o = { i: 0 }) { // minimal CBOR reader (enough for WebAuthn)
  const b = buf[o.i++], t = b >> 5, a = b & 31; let n = a;
  if (a === 24) n = buf[o.i++]; else if (a === 25) { n = buf.readUInt16BE(o.i); o.i += 2; } else if (a === 26) { n = buf.readUInt32BE(o.i); o.i += 4; } else if (a === 27) { n = Number(buf.readBigUInt64BE(o.i)); o.i += 8; } else if (a > 27) throw new Error('bad cbor');
  if (t === 0) return n; if (t === 1) return -1 - n;
  if (t === 2) { const v = buf.subarray(o.i, o.i + n); o.i += n; return v; }
  if (t === 3) { const v = buf.toString('utf8', o.i, o.i + n); o.i += n; return v; }
  if (t === 4) { const r = []; for (let k = 0; k < n; k++) r.push(cbor(buf, o)); return r; }
  if (t === 5) { const m = new Map(); for (let k = 0; k < n; k++) { const key = cbor(buf, o); m.set(key, cbor(buf, o)); } return m; }
  if (t === 7) return a === 20 ? false : a === 21 ? true : null;
  throw new Error('unsupported cbor');
}
function parseAuth(ad) {
  if (ad.length < 37) throw new Error('bad authenticator data');
  const r = { rpIdHash: ad.subarray(0, 32), flags: ad[32], counter: ad.readUInt32BE(33) };
  if (r.flags & 0x40) { const len = ad.readUInt16BE(53); r.credId = ad.subarray(55, 55 + len); r.cose = cbor(ad.subarray(55 + len)); }
  return r;
}
function toJwk(c) {
  const kty = c.get(1), alg = c.get(3);
  if (kty === 2 && alg === -7 && c.get(-1) === 1) return { alg, jwk: { kty: 'EC', crv: 'P-256', x: b64u(c.get(-2)), y: b64u(c.get(-3)) } };
  if (kty === 3 && alg === -257) return { alg, jwk: { kty: 'RSA', n: b64u(c.get(-1)), e: b64u(c.get(-2)) } };
  throw new Error('This device uses a key type that is not supported');
}
function checkClient(cdB64, type, challenge, origin) {
  const raw = unb64u(cdB64), cd = JSON.parse(raw.toString('utf8'));
  if (cd.type !== type || cd.challenge !== challenge || cd.origin !== origin) throw new Error('Passkey check failed (the request did not match this website)');
  return raw;
}
const verified = (p, rpID) => p.rpIdHash.equals(sha(rpID)) && (p.flags & 1) && (p.flags & 4);
function register(resp, { challenge, origin, rpID }) {
  checkClient(resp.response.clientDataJSON, 'webauthn.create', challenge, origin);
  const p = parseAuth(cbor(unb64u(resp.response.attestationObject)).get('authData'));
  if (!verified(p, rpID) || !p.credId) throw new Error('Passkey check failed (your device did not confirm it was you)');
  return { credId: b64u(p.credId), ...toJwk(p.cose), counter: p.counter };
}
function authenticate(resp, key, { challenge, origin, rpID }) {
  const raw = checkClient(resp.response.clientDataJSON, 'webauthn.get', challenge, origin), ad = unb64u(resp.response.authenticatorData), p = parseAuth(ad);
  if (!verified(p, rpID)) throw new Error('Passkey check failed (your device did not confirm it was you)');
  const data = Buffer.concat([ad, sha(raw)]), pub = crypto.createPublicKey({ key: key.jwk, format: 'jwk' }), sig = unb64u(resp.response.signature);
  const ok = key.alg === -7 ? crypto.verify('sha256', data, { key: pub, dsaEncoding: 'der' }, sig) : crypto.verify('sha256', data, pub, sig);
  if (!ok) throw new Error('Passkey check failed (signature)');
  if ((p.counter || key.counter) && p.counter <= key.counter) throw new Error('Passkey check failed (counter)');
  return { counter: p.counter };
}
module.exports = { register, authenticate, b64u, unb64u };
