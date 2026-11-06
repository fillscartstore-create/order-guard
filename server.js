const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const db = require('./db');
const guard = require('./guard');
const shopify = require('./shopify');

const app = express();
const boot = { webhooks: {}, startedAt: new Date().toISOString() };

// ---------- Shopify webhook ----------
app.post('/webhooks/orders-create', express.raw({ type: () => true, limit: '2mb' }), (req, res) => {
  const store = cfg.storeByShop(req.get('X-Shopify-Shop-Domain') || '');
  if (!store || !shopify.verifyHmac(store, req.body, req.get('X-Shopify-Hmac-Sha256'))) return res.status(401).send('bad signature');
  res.status(200).send('ok'); // Shopify ko foran jawab, kaam peeche
  let payload; try { payload = JSON.parse(req.body.toString('utf8')); } catch { return; }
  guard.handleWebhookOrder(store, payload).catch((e) => console.error('webhook error', payload && payload.name, e.message));
});

// ---------- Cron (cron-job.org har 5 min) ----------
app.get('/cron/sweep', (req, res) => {
  if (!cfg.CRON_SECRET || req.query.key !== cfg.CRON_SECRET) return res.status(401).send('wrong key');
  guard.sweep().catch((e) => console.error('sweep error', e.message));
  res.send('started');
});
app.get('/health', (req, res) => res.send('ok'));

// ---------- Password ----------
function auth(req, res, next) {
  if (!cfg.DASHBOARD_PASSWORD) return res.status(500).send('DASHBOARD_PASSWORD set nahi hai');
  const h = req.get('authorization') || '';
  const [, b64] = h.split(' ');
  const pass = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
  const a = Buffer.from(crypto.createHash('sha256').update(pass).digest('hex'));
  const b = Buffer.from(crypto.createHash('sha256').update(cfg.DASHBOARD_PASSWORD).digest('hex'));
  if (crypto.timingSafeEqual(a, b)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Order Guard"').status(401).send('Password chahiye');
}
app.use(['/api', '/'], (req, res, next) => (req.path === '/health' ? next() : auth(req, res, next)));
app.use(express.json());

const TYPES = {
  action: ['ACTION_NEEDED', 'DUP_SHIPMENT', 'SHIPPED_CANCELLED', 'DUP_SHIPMENT_PHONE'],
  cancelled: ['CANCELLED', 'WOULD_CANCEL'],
  notes: ['NOTE'],
};

function eventFilter(qs) {
  const where = [], params = [];
  if (qs.tab === 'action') { where.push(`type = any($${params.push(TYPES.action)})`, 'not resolved'); }
  else if (TYPES[qs.tab]) where.push(`type = any($${params.push(TYPES[qs.tab])})`);
  if (qs.store) where.push(`store = $${params.push(qs.store)}`);
  if (qs.q) {
    const i = params.push('%' + String(qs.q).replace(/^#/, '') + '%');
    where.push(`(order_ref ilike $${i} or tracking ilike $${i} or phone ilike $${i} or reason ilike $${i})`);
  }
  return { sql: where.length ? 'where ' + where.join(' and ') : '', params };
}

app.get('/api/events', async (req, res) => {
  const f = eventFilter(req.query);
  const r = await db.q(`select * from events ${f.sql} order by at desc limit 500`, f.params);
  res.json(r.rows.map((e) => {
    const s = cfg.storeByKey(e.store);
    return { ...e, store_label: s ? s.label : e.store, link: s && e.order_id ? shopify.adminLink(s, e.order_id) : null };
  }));
});

app.get('/api/events.csv', async (req, res) => {
  const f = eventFilter(req.query);
  const r = await db.q(`select * from events ${f.sql} order by at desc limit 20000`, f.params);
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [['Time', 'Store', 'Order #', 'Tracking', 'Phone', 'Type', 'Reason', 'Resolved'].map(esc).join(',')];
  for (const e of r.rows) lines.push([new Date(e.at).toISOString(), e.store, e.order_ref, e.tracking, e.phone, e.type, e.reason, e.resolved ? 'yes' : 'no'].map(esc).join(','));
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="order-guard-log.csv"').send('\ufeff' + lines.join('\n'));
});

app.post('/api/events/:id/resolve', async (req, res) => {
  await db.q('update events set resolved=true where id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/summary', async (req, res) => {
  const c = await db.q(`select
      count(*) filter (where type = any($1) and not resolved) as action,
      count(*) filter (where type = any($2) and at >= date_trunc('day', now() at time zone 'Asia/Karachi') at time zone 'Asia/Karachi') as cancelled_today,
      count(*) filter (where type = any($2) and at >= now() - interval '30 days') as cancelled_30d,
      count(*) filter (where type = any($3) and at >= now() - interval '30 days') as notes_30d
    from events`, [TYPES.action, TYPES.cancelled, TYPES.notes]);
  res.json({
    counts: c.rows[0],
    dryRun: cfg.DRY_RUN,
    rules: { dupDays: cfg.DUP_WINDOW_DAYS, ipDays: cfg.IP_WINDOW_DAYS },
    activeFrom: new Date(await guard.activeFrom()).toISOString(),
    lastSweep: await db.kvGet('last_sweep'),
    stores: cfg.stores.map((s) => ({ key: s.key, label: s.label, webhook: boot.webhooks[s.key], ...(guard.status[s.key] || {}) })),
  });
});

app.post('/api/run', (req, res) => { guard.sweep().catch(() => {}); res.json({ ok: true }); });

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Start ----------
async function start() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL set nahi hai');
  if (!cfg.stores.length) throw new Error('Koi store set nahi (PM_SHOP / FC_SHOP)');
  await db.init();
  await guard.activeFrom();
  app.listen(cfg.PORT, () => console.log('Order Guard chal raha hai, port', cfg.PORT, cfg.DRY_RUN ? '(TEST MODE)' : ''));

  for (const s of cfg.stores) {
    if (!cfg.APP_URL) { boot.webhooks[s.key] = { ok: false, msg: 'APP_URL set nahi' }; continue; }
    try {
      const m = await shopify.ensureWebhook(s, `https://${cfg.APP_URL}/webhooks/orders-create`);
      boot.webhooks[s.key] = { ok: true, msg: 'Webhook ' + m };
    } catch (e) { boot.webhooks[s.key] = { ok: false, msg: e.message }; }
  }
  guard.sweep().catch((e) => console.error(e));
  setInterval(() => guard.sweep().catch((e) => console.error(e)), cfg.SWEEP_MINUTES * 60000);
}
start().catch((e) => { console.error('START FAIL:', e.message); process.exit(1); });
