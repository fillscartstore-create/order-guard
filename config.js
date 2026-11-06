// Saari settings Render ke Environment Variables se aati hain.
const num = (v, d) => (v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : d);
const clean = (s) => (s || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');

const STORE_DEFS = [
  { key: 'pm', prefix: 'PM', label: 'Premium Mall' },
  { key: 'fc', prefix: 'FC', label: 'FillsCart' },
];

const stores = STORE_DEFS.map((s) => ({
  ...s,
  shop: clean(process.env[`${s.prefix}_SHOP`]),
  clientId: (process.env[`${s.prefix}_CLIENT_ID`] || '').trim(),
  clientSecret: (process.env[`${s.prefix}_CLIENT_SECRET`] || '').trim(),
  adminToken: (process.env[`${s.prefix}_ADMIN_TOKEN`] || '').trim(), // sirf purane legacy app ke liye (optional)
  webhookSecret: (process.env[`${s.prefix}_WEBHOOK_SECRET`] || '').trim(), // optional, warna client secret
  iwKey: (process.env[`${s.prefix}_INSTAWORLD_KEY`] || '').trim(),
})).filter((s) => s.shop);

module.exports = {
  stores,
  storeByKey: (k) => stores.find((s) => s.key === k),
  storeByShop: (shop) => stores.find((s) => s.shop === clean(shop)),
  APP_URL: clean(process.env.APP_URL),
  PORT: num(process.env.PORT, 3000),
  DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD || '',
  CRON_SECRET: process.env.CRON_SECRET || '',
  DRY_RUN: String(process.env.DRY_RUN || 'false').toLowerCase() === 'true',
  DUP_WINDOW_DAYS: num(process.env.DUP_WINDOW_DAYS, 30),
  IP_WINDOW_DAYS: num(process.env.IP_WINDOW_DAYS, 3),
  LOOKBACK_DAYS: num(process.env.LOOKBACK_DAYS, 60),
  IW_LOOKBACK_DAYS: num(process.env.IW_LOOKBACK_DAYS, 120),
  SWEEP_MINUTES: num(process.env.SWEEP_MINUTES, 5),
  GUARD_ACTIVE_FROM: process.env.GUARD_ACTIVE_FROM || '',
  MANUAL_SOURCES: (process.env.MANUAL_SOURCES || 'shopify_draft_order,pos').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
  KEEP_TAG: (process.env.KEEP_TAG || 'KEEP').toLowerCase(),
};
