require('dotenv').config();
const express = require('express'), crypto = require('crypto'), Database = require('better-sqlite3');
const E = process.env, SUBJECTS = ['chemistry', 'physics'], DAY = 864e5;
const BASE = E.DARAJA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
const db = new Database(E.DB_FILE || 'data.db');
db.exec(`
CREATE TABLE IF NOT EXISTS users(email TEXT PRIMARY KEY, salt TEXT, hash TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, email TEXT, role TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS subs(email TEXT, subject TEXT, phone TEXT, expires INTEGER DEFAULT 0, PRIMARY KEY(email, subject));
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY AUTOINCREMENT, checkout_id TEXT UNIQUE, email TEXT, subject TEXT,
  phone TEXT, amount INTEGER, status TEXT, receipt TEXT UNIQUE, created INTEGER);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS activity(t INTEGER, msg TEXT);`);
for (const q of ['ALTER TABLE subs ADD COLUMN phone_at INTEGER DEFAULT 0', 'ALTER TABLE activity ADD COLUMN email TEXT', 'ALTER TABLE users ADD COLUMN last_login INTEGER', 'ALTER TABLE users ADD COLUMN last_seen INTEGER', "ALTER TABLE users ADD COLUMN photo TEXT DEFAULT ''"]) { try { db.exec(q); } catch (e) { /* already exists */ } }
const get = (k, d) => (db.prepare('SELECT v FROM settings WHERE k=?').get(k) || { v: d }).v;
const set = (k, v) => db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
const log = (m, email) => db.prepare('INSERT INTO activity(t,msg,email) VALUES(?,?,?)').run(Date.now(), m, email || ((String(m).match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/) || [])[0] || null));
const hash = (p, s) => crypto.scryptSync(p, s, 64).toString('hex');
const phoneOk = p => { p = String(p || '').replace(/[\s+-]/g, ''); if (/^0\d{9}$/.test(p)) p = '254' + p.slice(1); return /^254\d{9}$/.test(p) ? p : null; };

const app = express();
app.set('trust proxy', 1);
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' }); next(); });
const hits = new Map();
const limit = (name, max, ms) => (req, res, next) => {
  const k = name + req.ip, n = Date.now(), a = (hits.get(k) || []).filter(t => n - t < ms);
  if (a.length >= max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  a.push(n); hits.set(k, a); next();
};
setInterval(() => hits.clear(), 3600e3).unref();
const seenAt = new Map();
const seen = email => { const n = Date.now(); if (n - (seenAt.get(email) || 0) < 60e3) return; seenAt.set(email, n); db.prepare('UPDATE users SET last_seen=? WHERE email=?').run(n, email); };
const stepup = email => { const r = db.prepare('SELECT expires FROM stepups WHERE email=?').get(email); db.prepare('DELETE FROM stepups WHERE email=?').run(email); return !!r && r.expires > Date.now(); };
const phoneFresh = (email, s) => { const r = db.prepare('SELECT phone_at FROM subs WHERE email=? AND subject=?').get(email, s); return !!r && !!r.phone_at && Date.now() - r.phone_at < 12 * 3600e3; };
async function mail(to, subject, text) { // optional: needs RESEND_API_KEY and MAIL_FROM
  if (!E.RESEND_API_KEY || !E.MAIL_FROM || !to) return false;
  try { const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + E.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: E.MAIL_FROM, to: [to], subject, text }) }); return r.ok; } catch (e) { return false; }
}

app.use(express.json({ limit: '25mb' }));
app.use(express.static('public')); // put your website files in /public

const auth = role => (req, res, next) => {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  const s = db.prepare('SELECT * FROM sessions WHERE token=? AND role=?').get(t, role);
  if (!s || Date.now() - s.created > 30 * DAY) return res.status(401).json({ error: 'Please log in' });
  req.email = s.email; if (role === 'student') seen(s.email); next();
};
const newSession = (email, role) => { const t = crypto.randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(t, email, role, Date.now()); return t; };

/* Public: only the site name and the help email are ever exposed */
app.get('/api/public', (_, res) => res.json({ site: get('site_name', 'Lab Report Portal'), helpEmail: get('help_email', ''), cover: get('cover', '') }));

/* Student accounts */
app.post('/api/register', limit('register', 20, 3600e3), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), pw = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email) || pw.length < 6) return res.status(400).json({ error: 'Valid email and 6+ character password required' });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return res.status(409).json({ error: 'Account already exists' });
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO users(email,salt,hash,created) VALUES(?,?,?,?)').run(email, salt, hash(pw, salt), Date.now());
  db.prepare('UPDATE users SET last_login=? WHERE email=?').run(Date.now(), email); log('New account ' + email); res.json({ token: newSession(email, 'student') });
});
app.post('/api/login', limit('login', 20, 600e3), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!u || hash(String(req.body.password || ''), u.salt) !== u.hash) return res.status(401).json({ error: 'Wrong email or password' });
  db.prepare('UPDATE users SET last_login=? WHERE email=?').run(Date.now(), email); log('Logged in', email); res.json({ token: newSession(email, 'student') });
});
app.get('/api/me', auth('student'), (req, res) => {
  const subs = {};
  for (const s of SUBJECTS) {
    const r = db.prepare('SELECT * FROM subs WHERE email=? AND subject=?').get(req.email, s);
    subs[s] = { active: active(req.email, s), expires: r ? r.expires : null, phone: r ? r.phone : null, price: +get('price_' + s, 300), days: +get('days_' + s, 30) };
  }
  const u = db.prepare('SELECT photo FROM users WHERE email=?').get(req.email);
  res.json({ email: req.email, subs, photo: (u && u.photo) || '', free: get('payments_enabled', '1') === '0', now: Date.now(), hasPasskey: !!db.prepare('SELECT 1 FROM passkeys WHERE email=?').get(req.email), instructions: Object.fromEntries(SUBJECTS.map(x => [x, get('extra_' + x, '')])) });
});

/* Log into a subject page with a phone number */
app.post('/api/subject/:s/login', auth('student'), (req, res) => {
  const s = req.params.s, phone = phoneOk(req.body.phone);
  if (!SUBJECTS.includes(s) || !phone) return res.status(400).json({ error: 'Invalid subject or phone number' });
  db.prepare('INSERT INTO subs(email,subject,phone,phone_at) VALUES(?,?,?,?) ON CONFLICT(email,subject) DO UPDATE SET phone=excluded.phone, phone_at=excluded.phone_at').run(req.email, s, phone, Date.now());
  log(`${req.email} logged into ${s}`); res.json({ ok: true });
});

/* Daraja */
let tok = { v: '', exp: 0 };
async function darajaToken() {
  if (tok.exp > Date.now()) return tok.v;
  const r = await fetch(BASE + '/oauth/v1/generate?grant_type=client_credentials', { headers: { Authorization: 'Basic ' + Buffer.from(E.CONSUMER_KEY + ':' + E.CONSUMER_SECRET).toString('base64') } });
  const j = await r.json(); if (!j.access_token) throw new Error('Daraja auth failed');
  tok = { v: j.access_token, exp: Date.now() + 3000e3 }; return tok.v;
}
app.post('/api/subject/:s/pay', auth('student'), async (req, res) => {
  try {
    const s = req.params.s, sub = db.prepare('SELECT * FROM subs WHERE email=? AND subject=?').get(req.email, s);
    if (!SUBJECTS.includes(s) || !sub) return res.status(400).json({ error: 'Log into the subject with your phone number first' });
    if (!sub.phone_at || Date.now() - sub.phone_at > 30 * 60e3) return res.status(400).json({ error: 'Enter your phone number to continue' });
    if (get('payments_enabled', '1') === '0') return res.status(400).json({ error: 'Payments are switched off. Access is free.' });
    const amount = Math.round(+get('price_' + s, 300)), ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const r = await fetch(BASE + '/mpesa/stkpush/v1/processrequest', {
      method: 'POST', headers: { Authorization: 'Bearer ' + await darajaToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: E.SHORTCODE, Password: Buffer.from(E.SHORTCODE + E.PASSKEY + ts).toString('base64'), Timestamp: ts,
        TransactionType: E.TRANSACTION_TYPE, Amount: amount, PartyA: sub.phone, PartyB: E.PARTYB || E.SHORTCODE, PhoneNumber: sub.phone,
        CallBackURL: `${E.PUBLIC_URL}/mpesa/callback/${E.CALLBACK_SECRET}`,
        AccountReference: get('site_name', 'Lab Report Portal').slice(0, 12), TransactionDesc: (get('site_name', 'Subscription')).slice(0, 13)
      })
    });
    const j = await r.json();
    if (j.ResponseCode !== '0') { log('M-Pesa prompt failed: ' + (j.errorMessage || j.ResponseDescription || 'unknown reason')); return res.status(502).json({ error: j.errorMessage || j.ResponseDescription || 'Could not send the M-Pesa prompt' }); }
    const id = db.prepare('INSERT INTO payments(checkout_id,email,subject,phone,amount,status,created) VALUES(?,?,?,?,?,?,?)').run(j.CheckoutRequestID, req.email, s, sub.phone, amount, 'pending', Date.now()).lastInsertRowid;
    log(`Payment prompt sent: ${req.email} ${s} KES ${amount}`); res.json({ paymentId: id });
  } catch (e) { console.error(e); log('M-Pesa connection error: ' + e.message); res.status(500).json({ error: 'Payment service unavailable' }); }
});
/* The page polls this until status becomes "paid" - access only opens after Safaricom confirms */
/* The page polls this. If Safaricom's callback was missed, ask Safaricom directly (STK query) so a paid student is never stuck. */
const lastQ = new Map();
function settleQuery(p, code) {
  if (db.prepare('SELECT status FROM payments WHERE id=?').get(p.id).status !== 'pending') return;
  if (code !== '0') { db.prepare("UPDATE payments SET status='failed' WHERE id=?").run(p.id); return log('Payment failed/cancelled ' + p.email); }
  db.transaction(() => {
    db.prepare("UPDATE payments SET status='paid' WHERE id=?").run(p.id);
    const cur = db.prepare('SELECT expires FROM subs WHERE email=? AND subject=?').get(p.email, p.subject);
    db.prepare('UPDATE subs SET expires=? WHERE email=? AND subject=?').run(Math.max(Date.now(), cur ? cur.expires : 0) + (+get('days_' + p.subject, 30)) * DAY, p.email, p.subject);
  })();
  log(`Payment confirmed (checked with Safaricom) ${p.email} ${p.subject}`);
}
app.get('/api/pay/:id', auth('student'), async (req, res) => {
  let p = db.prepare('SELECT * FROM payments WHERE id=? AND email=?').get(req.params.id, req.email);
  if (p && p.status === 'pending' && Date.now() - p.created > 40e3 && Date.now() - (lastQ.get(p.id) || 0) > 15e3) {
    lastQ.set(p.id, Date.now());
    try {
      const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
      const r = await fetch(BASE + '/mpesa/stkpushquery/v1/query', { method: 'POST', headers: { Authorization: 'Bearer ' + await darajaToken(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ BusinessShortCode: E.SHORTCODE, Password: Buffer.from(E.SHORTCODE + E.PASSKEY + ts).toString('base64'), Timestamp: ts, CheckoutRequestID: p.checkout_id }) });
      const j = await r.json();
      if (j.ResultCode !== undefined && j.ResultCode !== null && String(j.ResultCode) !== '') settleQuery(p, String(j.ResultCode));
    } catch (e) { /* try again on the next poll */ }
  }
  p = p && db.prepare('SELECT status FROM payments WHERE id=?').get(p.id);
  res.json({ status: p ? p.status : 'unknown' });
});

/* Safaricom calls this when the customer pays, cancels or fails */
app.post('/mpesa/callback/:secret', (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  if (req.params.secret !== E.CALLBACK_SECRET) return;
  const cb = req.body && req.body.Body && req.body.Body.stkCallback; if (!cb) return;
  const p = db.prepare('SELECT * FROM payments WHERE checkout_id=?').get(cb.CheckoutRequestID);
  if (!p || p.status !== 'pending') return;
  if (cb.ResultCode !== 0) { db.prepare('UPDATE payments SET status=? WHERE id=?').run('failed', p.id); return log('Payment failed/cancelled ' + p.email); }
  const m = {}; (cb.CallbackMetadata.Item || []).forEach(i => m[i.Name] = i.Value);
  if (+m.Amount < p.amount) { db.prepare('UPDATE payments SET status=? WHERE id=?').run('underpaid', p.id); return log('Underpaid ' + p.email); }
  db.transaction(() => {
    db.prepare('UPDATE payments SET status=?, receipt=? WHERE id=?').run('paid', m.MpesaReceiptNumber, p.id);
    const cur = db.prepare('SELECT expires FROM subs WHERE email=? AND subject=?').get(p.email, p.subject);
    const exp = Math.max(Date.now(), cur ? cur.expires : 0) + (+get('days_' + p.subject, 30)) * DAY;
    db.prepare('UPDATE subs SET expires=? WHERE email=? AND subject=?').run(exp, p.email, p.subject);
  })();
  log(`Payment confirmed ${m.MpesaReceiptNumber} ${p.email} ${p.subject}`);
});

/* Subject pages: blocked unless subscription is active */
app.get('/api/subject/:s/content', auth('student'), (req, res) => {
  const r = db.prepare('SELECT expires FROM subs WHERE email=? AND subject=?').get(req.email, req.params.s);
  if (!active(req.email, req.params.s)) return res.status(402).json({ error: 'Subscription required' });
  if (!phoneFresh(req.email, req.params.s)) return res.status(400).json({ error: 'Enter your phone number to continue' });
  res.json({ ok: true, expires: r ? r.expires : 0, chem: JSON.parse(get((req.params.s === 'physics' ? 'physdet_' : 'chemdet_') + req.email, '{}')), config: { idf: cfgOf(req.params.s).idf, vars: cfgOf(req.params.s).vars }, identity: JSON.parse((db.prepare('SELECT data FROM idents WHERE email=?').get(req.email) || { data: '{}' }).data) });
});

/* Admin */
app.post('/api/admin/login', limit('adminlogin', 8, 600e3), (req, res) => {
  const a = Buffer.from(String(req.body.password || '')), b = Buffer.from(E.ADMIN_PASSWORD || '');
  if (!b.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Wrong password' });
  res.json({ token: newSession('admin', 'admin') });
});
app.get('/api/admin/summary', auth('admin'), (_, res) => {
  const paid = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount),0) total FROM payments WHERE status='paid'").get();
  res.json({
    students: db.prepare('SELECT COUNT(*) n FROM users').get().n, users: db.prepare('SELECT email, created, last_login, last_seen FROM users ORDER BY created DESC').all(), mailOn: !!(E.RESEND_API_KEY && E.MAIL_FROM),
    live: { online: db.prepare('SELECT COUNT(*) n FROM users WHERE last_seen>?').get(Date.now() - 15 * 60e3).n, reports: db.prepare("SELECT id,email,subject,created FROM reports WHERE status='working'").all(), pending: db.prepare("SELECT id,email,subject,amount,created FROM payments WHERE status='pending'").all() }, paidSubscriptions: paid.n, totalKES: paid.total,
    subscriptions: db.prepare('SELECT email, subject, expires FROM subs WHERE expires>0 ORDER BY expires').all().map(r => ({ ...r, daysLeft: Math.max(0, Math.ceil((r.expires - Date.now()) / DAY)) })),
    payments: db.prepare('SELECT * FROM payments ORDER BY id DESC LIMIT 200').all(), activity: db.prepare('SELECT * FROM activity ORDER BY t DESC LIMIT 200').all(),
    settings: { payments_enabled: get('payments_enabled', '1'), extra_chemistry: get('extra_chemistry', ''), extra_physics: get('extra_physics', ''), chem_intro_words: get('chem_intro_words', 900), chem_min_refs: get('chem_min_refs', 7), chem_min_obj: get('chem_min_obj', 4), site_name: get('site_name', ''), help_email: get('help_email', ''), ...Object.fromEntries(SUBJECTS.flatMap(s => [['price_' + s, get('price_' + s, 300)], ['days_' + s, get('days_' + s, 30)]])) }
  });
});
app.post('/api/admin/settings', auth('admin'), (req, res) => {
  const ok = ['payments_enabled', 'extra_chemistry', 'extra_physics', 'chem_intro_words', 'chem_min_refs', 'chem_min_obj', 'site_name', 'help_email', ...SUBJECTS.flatMap(s => ['price_' + s, 'days_' + s])];
  for (const [k, v] of Object.entries(req.body)) if (ok.includes(k)) set(k, v);
  log('Admin changed settings'); res.json({ ok: true });
});

/* ---- Reports, email-change approval, subject settings, cover photo ---- */
db.exec(`CREATE TABLE IF NOT EXISTS idents(email TEXT PRIMARY KEY, data TEXT);
CREATE TABLE IF NOT EXISTS emailreq(id INTEGER PRIMARY KEY AUTOINCREMENT, old TEXT, new TEXT, identity TEXT, status TEXT, created INTEGER);`);
const DEF = {
  chemistry: { idf: 'Full name,Reg number,Course', vars: 'mass,volume', calc: 'conc = mass/volume\nmoles = conc*volume',
    src: 'LibreTexts Chemistry|https://chem.libretexts.org\nRoyal Society of Chemistry|https://www.rsc.org/education',
    fmt: 'REPORT: {subject}\nStudent: {Full name} | Reg: {Reg number} | Course: {Course}\n\nIntroduction\n{intro}\n\nResults\nmass = {mass}, volume = {volume}\nconc = {conc}\nmoles = {moles}\n\nConclusion\n{concl}' },
  physics: { idf: 'Full name,Reg number,Course', vars: 'distance,time', calc: 'speed = distance/time\nkinetic = 0.5*2*speed*speed',
    src: 'HyperPhysics|http://hyperphysics.phy-astr.gsu.edu\nPhET Simulations|https://phet.colorado.edu',
    fmt: 'REPORT: {subject}\nStudent: {Full name} | Reg: {Reg number} | Course: {Course}\n\nIntroduction\n{intro}\n\nResults\ndistance = {distance}, time = {time}\nspeed = {speed}\nkinetic = {kinetic}\n\nConclusion\n{concl}' }
};
const cfgOf = s => { try { return { ...DEF[s], ...JSON.parse(get('cfg_' + s, '{}')) }; } catch (e) { return DEF[s]; } };
const list = x => String(x).split(',').map(a => a.trim()).filter(Boolean);
const active = (email, s) => { if (get('payments_enabled', '1') === '0') return true; const r = db.prepare('SELECT expires FROM subs WHERE email=? AND subject=?').get(email, s); return !!r && r.expires > Date.now(); };

app.post('/api/subject/:s/report', auth('student'), (req, res) => {
  const s = req.params.s;
  if (!SUBJECTS.includes(s) || !active(req.email, s)) return res.status(402).json({ error: 'Subscription required' });
  const c = cfgOf(s), id = {}, sc = {};
  for (const f of list(c.idf)) id[f] = String((req.body.identity || {})[f] || '').slice(0, 100);
  for (const f of list(c.vars)) { const n = parseFloat((req.body.values || {})[f]); if (!isFinite(n)) return res.status(400).json({ error: 'Enter a number for ' + f }); sc[f] = n; }
  try { c.calc.split(/[\n;]/).filter(l => l.includes('=')).forEach(l => { const [a, ...b] = l.split('='); sc[a.trim()] = new Function('S', 'with(Math){with(S){return (' + b.join('=') + ')}}')(sc); }); }
  catch (e) { return res.status(400).json({ error: 'A formula has an error. Contact the help desk.' }); }
  db.prepare('INSERT INTO idents VALUES(?,?) ON CONFLICT(email) DO UPDATE SET data=excluded.data').run(req.email, JSON.stringify(id));
  const h = crypto.createHash('sha256').update(req.email + s).digest(), name = s[0].toUpperCase() + s.slice(1);
  const I = [`This experiment in ${name} set out to apply the measured values to the relevant principles.`, `The aim of this ${name} report is to analyse the recorded data and draw conclusions.`, `This report presents and interprets the data collected in the ${name} practical.`];
  const K = ['The calculated results are consistent with the measurements taken.', 'From the values obtained, the derived quantities follow as shown above.', 'The analysis confirms the expected relationship between the measured values.'];
  const m = { subject: name, intro: I[h[0] % 3], concl: K[h[1] % 3], ...id };
  Object.keys(sc).forEach(k => m[k] = +sc[k].toPrecision(5));
  const sources = c.src.split('\n').map(l => l.split('|')).filter(a => a[1]).map(a => ({ title: a[0], url: a[1] }));
  log(`${req.email} generated ${s} report`);
  res.json({ text: c.fmt.replace(/\{([^}]+)\}/g, (a, b) => m[b] ?? a), sources, youtube: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(name + ' experiment explained') });
});
app.post('/api/me/password', auth('student'), (req, res) => {
  if (!stepup(req.email)) return res.status(403).json({ error: 'Confirm with your fingerprint or passkey first.' });
  const pw = String(req.body.password || ''); if (pw.length < 6) return res.status(400).json({ error: '6+ characters required' });
  const salt = crypto.randomBytes(16).toString('hex'); db.prepare('UPDATE users SET salt=?, hash=? WHERE email=?').run(salt, hash(pw, salt), req.email); res.json({ ok: true });
});
app.post('/api/me/email-request', auth('student'), (req, res) => {
  if (!stepup(req.email)) return res.status(403).json({ error: 'Confirm with your fingerprint or passkey first.' });
  const n = String(req.body.email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(n)) return res.status(400).json({ error: 'Enter a valid email' });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(n)) return res.status(409).json({ error: 'That email is already in use' });
  const i = db.prepare('SELECT data FROM idents WHERE email=?').get(req.email);
  db.prepare('INSERT INTO emailreq(old,new,identity,status,created) VALUES(?,?,?,?,?)').run(req.email, n, i ? i.data : '{}', 'pending', Date.now());
  log(`Email change requested ${req.email} -> ${n}`); mail(E.ADMIN_EMAIL, 'Email change request', `${req.email} wants to change their email to ${n}.\nDetails: ${i ? i.data : '{}'}\nApprove or reject it in your admin page (Requests tab).`); res.json({ ok: true });
});
app.get('/api/admin/extra', auth('admin'), (_, res) => res.json({ subjects: Object.fromEntries(SUBJECTS.map(s => [s, cfgOf(s)])), requests: db.prepare('SELECT * FROM emailreq ORDER BY id DESC').all() }));
app.post('/api/admin/email-request/:id', auth('admin'), (req, res) => {
  const r = db.prepare('SELECT * FROM emailreq WHERE id=?').get(req.params.id);
  if (!r || r.status !== 'pending') return res.status(404).json({ error: 'Not found' });
  if (req.body.approve) {
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(r.new)) return res.status(409).json({ error: 'New email already in use' });
    db.transaction(() => { for (const t of ['users', 'sessions', 'subs', 'payments', 'idents', 'reports', 'activity', 'passkeys']) db.prepare(`UPDATE ${t} SET email=? WHERE email=?`).run(r.new, r.old); })();
  }
  db.prepare('UPDATE emailreq SET status=? WHERE id=?').run(req.body.approve ? 'approved' : 'rejected', r.id); log(`Email change ${req.body.approve ? 'approved' : 'rejected'}: ${r.old}`); res.json({ ok: true });
});
app.post('/api/admin/subject/:s', auth('admin'), (req, res) => {
  const s = req.params.s; if (!SUBJECTS.includes(s)) return res.status(404).json({ error: 'Unknown subject' });
  const c = cfgOf(s); for (const k of ['idf', 'vars', 'calc', 'fmt', 'src']) if (typeof req.body[k] === 'string') c[k] = req.body[k].slice(0, 5000);
  set('cfg_' + s, JSON.stringify(c)); log('Admin updated ' + s + ' format'); res.json({ ok: true });
});
app.post('/api/admin/cover', auth('admin'), (req, res) => {
  const d = String(req.body.image || ''); if (!/^data:image\/(png|jpe?g|webp);base64,/.test(d) || d.length > 2.5e6) return res.status(400).json({ error: 'Use a PNG/JPG/WEBP under about 1.8 MB' });
  set('cover', d); res.json({ ok: true });
});

/* Student deletes their own account */
app.post('/api/me/delete', auth('student'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(req.email);
  if (!u || hash(String(req.body.password || ''), u.salt) !== u.hash) return res.status(403).json({ error: 'Wrong password' });
  if (db.prepare("SELECT 1 FROM reports WHERE email=? AND status='working'").get(req.email)) return res.status(409).json({ error: 'A report is still being prepared. Try again when it has finished.' });
  if (db.prepare("SELECT 1 FROM payments WHERE email=? AND status='pending' AND created>?").get(req.email, Date.now() - 10 * 60e3)) return res.status(409).json({ error: 'A payment is in progress. Try again in a few minutes.' });
  const files = db.prepare('SELECT id FROM reports WHERE email=?').all(req.email), anon = 'deleted-' + crypto.randomBytes(4).toString('hex');
  db.transaction(() => {
    for (const t of ['subs', 'idents', 'reports', 'sessions', 'users', 'activity', 'passkeys', 'stepups', 'challenges', 'resets']) db.prepare(`DELETE FROM ${t} WHERE email=?`).run(req.email);
    db.prepare("DELETE FROM emailreq WHERE old=? AND status='pending'").run(req.email);
    db.prepare('DELETE FROM settings WHERE k=?').run('chemdet_' + req.email); db.prepare('DELETE FROM settings WHERE k=?').run('physdet_' + req.email);
    db.prepare('UPDATE payments SET email=? WHERE email=?').run(anon, req.email); // amounts and M-Pesa receipts stay for your accounts
  })();
  const dir = require('path').join(E.DATA_DIR || '.', 'reports');
  files.forEach(f => { try { require('fs').unlinkSync(require('path').join(dir, f.id + '.docx')); } catch (e) {} });
  log('A student account was deleted'); res.json({ ok: true });
});

require('./v2')({ app, db, auth, get, log, mail, E, crypto, darajaToken });
require('./extras')({ app, db, auth, hash, log, limit, E, crypto, mail });
require('./chem')({ app, db, auth, get, set, log, active, phoneFresh, E });

app.listen(E.PORT || 3000, () => console.log('Server running on port ' + (E.PORT || 3000)));
