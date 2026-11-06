const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

// Tables khud ban jati hain, Supabase mein SQL chalane ki zaroorat nahi.
const SCHEMA = `
create table if not exists orders (
  store text not null,
  id text not null,
  name text not null,
  name_norm text not null,
  created_at timestamptz not null,
  cancelled boolean not null default false,
  source text,
  tags text[] not null default '{}',
  phones text[] not null default '{}',
  ip text,
  shipped boolean not null default false,
  manual boolean not null default false,
  guard_cancel_at timestamptz,
  cancel_attempts int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (store, id)
);
create index if not exists orders_phones_idx on orders using gin (phones);
create index if not exists orders_created_idx on orders (store, created_at);
create index if not exists orders_norm_idx on orders (store, name_norm);

create table if not exists shipments (
  store text not null,
  tracking text not null,
  ref_no text,
  ref_norm text,
  phone text,
  status_code text,
  status_group text,
  status_label text,
  created_at timestamptz,
  updated_at timestamptz,
  primary key (store, tracking)
);
create index if not exists shipments_ref_idx on shipments (store, ref_norm);

-- Har cancel/hold/issue yahan aata hai. order_ref (order number) khali ho hi nahi sakta.
create table if not exists events (
  id bigserial primary key,
  at timestamptz not null default now(),
  store text not null,
  order_ref text not null check (length(trim(order_ref)) > 0),
  order_id text,
  tracking text,
  phone text,
  type text not null,
  severity text not null default 'info',
  reason text not null,
  resolved boolean not null default false,
  dedupe text unique
);
create index if not exists events_at_idx on events (at desc);

create table if not exists kv (k text primary key, v text);
`;

async function init() { await pool.query(SCHEMA); }
const q = (text, params) => pool.query(text, params);

async function kvGet(k) { const r = await q('select v from kv where k=$1', [k]); return r.rows[0] ? r.rows[0].v : null; }
async function kvSet(k, v) { await q('insert into kv(k,v) values($1,$2) on conflict (k) do update set v=excluded.v', [k, String(v)]); }

module.exports = { pool, q, init, kvGet, kvSet };
