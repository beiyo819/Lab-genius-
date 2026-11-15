/* Password reset, and admin tools for students */
const fs = require('fs'), path = require('path');
module.exports = ({ app, db, auth, hash, log, limit, E, crypto, mail }) => {
  db.exec('CREATE TABLE IF NOT EXISTS resets(email TEXT PRIMARY KEY, code_hash TEXT, expires INTEGER, tries INTEGER DEFAULT 0)');
  const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex'), mailOn = () => !!(E.RESEND_API_KEY && E.MAIL_FROM), clean = e => String(e || '').trim().toLowerCase();
  const setPw = (email, pw) => { const salt = crypto.randomBytes(16).toString('hex'); db.prepare('UPDATE users SET salt=?, hash=? WHERE email=?').run(salt, hash(pw, salt), email); db.prepare('DELETE FROM sessions WHERE email=?').run(email); };

  app.post('/api/forgot', limit('forgot', 5, 3600e3), async (req, res) => {
    const email = clean(req.body.email);
    if (mailOn() && db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) {
      const code = String(crypto.randomInt(100000, 1000000));
      db.prepare('INSERT INTO resets VALUES(?,?,?,0) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash, expires=excluded.expires, tries=0').run(email, sha(code), Date.now() + 15 * 60e3);
      await mail(email, 'Your password reset code', `Your password reset code is ${code}. It expires in 15 minutes. If you did not ask for it, ignore this email.`);
    }
    res.json({ ok: true, emailEnabled: mailOn() }); // same answer whether or not the account exists
  });
  app.post('/api/reset', limit('reset', 10, 3600e3), (req, res) => {
    const email = clean(req.body.email), pw = String(req.body.password || ''), r = db.prepare('SELECT * FROM resets WHERE email=?').get(email);
    if (!r || r.expires < Date.now() || r.tries >= 5) return res.status(400).json({ error: 'The code is invalid or has expired. Ask for a new one.' });
    if (sha(req.body.code) !== r.code_hash) { db.prepare('UPDATE resets SET tries=tries+1 WHERE email=?').run(email); return res.status(400).json({ error: 'Wrong code' }); }
    if (pw.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });
    setPw(email, pw); db.prepare('DELETE FROM resets WHERE email=?').run(email); log('Password reset by email code'); res.json({ ok: true });
  });

  app.post('/api/admin/student/reset', auth('admin'), (req, res) => {
    const email = clean(req.body.email), pw = String(req.body.password || '');
    if (pw.length < 6 || !db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return res.status(400).json({ error: 'Unknown student or password shorter than 6 characters' });
    setPw(email, pw); log('Admin reset the password of ' + email); res.json({ ok: true });
  });
  app.post('/api/admin/student/delete', auth('admin'), (req, res) => {
    const email = clean(req.body.email);
    if (!db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return res.status(404).json({ error: 'Unknown student' });
    const files = db.prepare('SELECT id FROM reports WHERE email=?').all(email), anon = 'deleted-' + crypto.randomBytes(4).toString('hex');
    db.transaction(() => {
      for (const t of ['subs', 'idents', 'reports', 'sessions', 'users', 'activity', 'passkeys', 'stepups', 'challenges', 'resets']) db.prepare(`DELETE FROM ${t} WHERE email=?`).run(email);
      db.prepare("DELETE FROM emailreq WHERE old=? AND status='pending'").run(email);
      db.prepare('DELETE FROM settings WHERE k IN (?,?)').run('chemdet_' + email, 'physdet_' + email);
      db.prepare('UPDATE payments SET email=? WHERE email=?').run(anon, email);
    })();
    const dir = path.join(E.DATA_DIR || '.', 'reports'); files.forEach(f => { try { fs.unlinkSync(path.join(dir, f.id + '.docx')); } catch (e) {} });
    log('Admin deleted the account ' + email); res.json({ ok: true });
  });
};
