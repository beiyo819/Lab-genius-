/* Version 2 features: passkeys, student storage/activity/photo, admin broadcast/reset/M-Pesa check */
const fs = require('fs'), path = require('path'), W = require('./webauthn');
module.exports = ({ app, db, auth, get, log, mail, E, crypto, darajaToken }) => {
  const DIR = path.join(E.DATA_DIR || '.', 'reports'), mailOn = () => !!(E.RESEND_API_KEY && E.MAIL_FROM);
  db.exec(`CREATE TABLE IF NOT EXISTS passkeys(id TEXT PRIMARY KEY, email TEXT, jwk TEXT, alg INTEGER, counter INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS challenges(email TEXT PRIMARY KEY, kind TEXT, challenge TEXT, expires INTEGER);
CREATE TABLE IF NOT EXISTS stepups(email TEXT PRIMARY KEY, expires INTEGER);`);

  /* Fingerprint / passkey: needed before a student can change password or email */
  const ctx = req => ({ origin: req.protocol + '://' + req.get('host'), rpID: req.hostname });
  const newChallenge = (email, kind) => { const c = W.b64u(crypto.randomBytes(32)); db.prepare('INSERT INTO challenges VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET kind=excluded.kind, challenge=excluded.challenge, expires=excluded.expires').run(email, kind, c, Date.now() + 5 * 60e3); return c; };
  const takeChallenge = (email, kind) => { const r = db.prepare('SELECT * FROM challenges WHERE email=?').get(email); db.prepare('DELETE FROM challenges WHERE email=?').run(email); if (!r || r.kind !== kind || r.expires < Date.now()) throw new Error('The passkey request expired. Please try again.'); return r.challenge; };
  const bad = (res, e) => res.status(400).json({ error: e.message || 'Passkey check failed' });
  app.post('/api/me/passkey/register-options', auth('student'), (req, res) => {
    const ex = db.prepare('SELECT id FROM passkeys WHERE email=?').all(req.email);
    res.json({ challenge: newChallenge(req.email, 'reg'), rp: { name: get('site_name', 'Lab Report Portal'), id: ctx(req).rpID }, user: { id: W.b64u(crypto.createHash('sha256').update(req.email).digest()), name: req.email, displayName: req.email },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }], authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000, attestation: 'none', excludeCredentials: ex.map(r => ({ type: 'public-key', id: r.id })) });
  });
  app.post('/api/me/passkey/register-verify', auth('student'), (req, res) => {
    try {
      const k = W.register(req.body, { challenge: takeChallenge(req.email, 'reg'), ...ctx(req) });
      db.prepare('INSERT INTO passkeys VALUES(?,?,?,?,?,?)').run(k.credId, req.email, JSON.stringify(k.jwk), k.alg, k.counter, Date.now());
      log('Fingerprint/passkey added', req.email); res.json({ ok: true });
    } catch (e) { bad(res, e); }
  });
  app.post('/api/me/passkey/auth-options', auth('student'), (req, res) => {
    const keys = db.prepare('SELECT id FROM passkeys WHERE email=?').all(req.email);
    if (!keys.length) return res.status(400).json({ error: 'Set up your fingerprint or passkey first' });
    res.json({ challenge: newChallenge(req.email, 'auth'), rpId: ctx(req).rpID, allowCredentials: keys.map(k => ({ type: 'public-key', id: k.id })), userVerification: 'required', timeout: 60000 });
  });
  app.post('/api/me/passkey/auth-verify', auth('student'), (req, res) => {
    try {
      const k = db.prepare('SELECT * FROM passkeys WHERE id=? AND email=?').get(String(req.body.id || ''), req.email);
      if (!k) throw new Error('Unknown passkey');
      const r = W.authenticate(req.body, { jwk: JSON.parse(k.jwk), alg: k.alg, counter: k.counter }, { challenge: takeChallenge(req.email, 'auth'), ...ctx(req) });
      db.prepare('UPDATE passkeys SET counter=? WHERE id=?').run(r.counter, k.id);
      db.prepare('INSERT INTO stepups VALUES(?,?) ON CONFLICT(email) DO UPDATE SET expires=excluded.expires').run(req.email, Date.now() + 5 * 60e3);
      log('Confirmed with fingerprint/passkey', req.email); res.json({ ok: true });
    } catch (e) { bad(res, e); }
  });

  /* Student: activity, storage, photo */
  app.get('/api/me/activity', auth('student'), (req, res) => res.json(db.prepare('SELECT t, msg FROM activity WHERE email=? ORDER BY t DESC LIMIT 100').all(req.email)));
  app.get('/api/me/storage', auth('student'), (req, res) => res.json(db.prepare('SELECT id, subject, title, status, error, created FROM reports WHERE email=? ORDER BY id DESC').all(req.email)));
  app.post('/api/me/report/delete', auth('student'), (req, res) => {
    const r = db.prepare("SELECT id FROM reports WHERE id=? AND email=? AND status!='working'").get(req.body.id, req.email);
    if (!r) return res.status(404).json({ error: 'Report not found, or it is still being prepared' });
    db.prepare('DELETE FROM reports WHERE id=?').run(r.id); try { fs.unlinkSync(path.join(DIR, r.id + '.docx')); } catch (e) {}
    log('Deleted a saved report', req.email); res.json({ ok: true });
  });
  app.post('/api/me/photo', auth('student'), (req, res) => {
    const d = String(req.body.image || '');
    if (d.length > 250000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(d)) return res.status(400).json({ error: 'Use a JPG or PNG photo' });
    db.prepare('UPDATE users SET photo=? WHERE email=?').run(d, req.email); log('Profile photo updated', req.email); res.json({ ok: true });
  });
  app.post('/api/me/photo/remove', auth('student'), (req, res) => { db.prepare("UPDATE users SET photo='' WHERE email=?").run(req.email); res.json({ ok: true }); });

  /* Admin */
  app.post('/api/admin/activity/reset', auth('admin'), (req, res) => { db.prepare('DELETE FROM activity').run(); log('Activity list was cleared by the admin'); res.json({ ok: true }); });
  app.post('/api/admin/broadcast', auth('admin'), (req, res) => {
    const subject = String(req.body.subject || '').trim().slice(0, 150), text = String(req.body.message || '').trim().slice(0, 5000);
    if (!mailOn()) return res.status(503).json({ error: 'Email is not set up yet. Add RESEND_API_KEY and MAIL_FROM in your host settings.' });
    if (!subject || !text) return res.status(400).json({ error: 'Write a subject and a message' });
    const to = db.prepare('SELECT email FROM users').all().map(r => r.email);
    res.json({ ok: true, queued: to.length });
    (async () => { let ok = 0; for (const e of to) { if (await mail(e, subject, text)) ok++; await new Promise(r => setTimeout(r, 600)); } log(`Email "${subject}" reached ${ok} of ${to.length} students`); })();
  });
  app.get('/api/admin/mpesa-check', auth('admin'), async (req, res) => {
    const out = { env: E.DARAJA_ENV || 'sandbox', shortcode: E.SHORTCODE || '', callbackUrl: E.PUBLIC_URL ? E.PUBLIC_URL.replace(/\/$/, '') + '/mpesa/callback/(secret)' : '',
      missing: ['CONSUMER_KEY', 'CONSUMER_SECRET', 'SHORTCODE', 'PARTYB', 'PASSKEY', 'PUBLIC_URL', 'CALLBACK_SECRET'].filter(k => !E[k]) };
    try { await darajaToken(); out.tokenOk = true; } catch (e) { out.tokenOk = false; out.error = 'Safaricom did not accept the Consumer Key/Secret, or could not be reached.'; }
    res.json(out);
  });
};
