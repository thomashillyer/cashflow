-- Shared records for Neri Cash. Mirrors schema/records.ts and schema/intake.ts.
--
-- Conventions
--   * Every table is scoped by business_id; primary keys are (business_id, id) so
--     stable source-derived ids (inv-INV-1187, evt-inv-INV-1187-0) never collide
--     across businesses and re-imports are idempotent upserts.
--   * Amounts are bigint minor units. Calendar dates are `date` (YYYY-MM-DD).
--     Timestamps are timestamptz. Nested objects (sourceRef, anchors, claim, ...)
--     are jsonb with the same camelCase shape as the TypeScript types.
--   * source_system / source_record are generated from source_ref for lookups and
--     the idempotency indexes; write source_ref, never these columns.
--   * Cross-record references (party_id, commitment_id, ...) are not foreign keys,
--     so adapters can upsert in any order. Only business_id is enforced.

create table businesses (
  id            text primary key,
  name          text not null,
  profile       jsonb not null default '{}'::jsonb,  -- schema/profile.ts Profile
  -- true for sandbox/demo businesses. The hackathon RLS policies below only
  -- expose synthetic businesses to the anon/authenticated keys.
  is_synthetic  boolean not null default true,
  created_at    timestamptz not null default now()
);

create table parties (
  business_id  text not null references businesses (id) on delete cascade,
  id           text not null,
  name         text not null,
  kind         text not null check (kind in ('customer', 'supplier', 'employee', 'agency', 'other')),
  tags         text[] not null default '{}',
  notes        text[] not null default '{}',
  contacts     jsonb,   -- { emailDomains?, phones? }
  lag_stats    jsonb,   -- { n, medianDaysLate, iqrDays, updatedAt }
  created_at   timestamptz not null default now(),
  primary key (business_id, id)
);

create table commitments (
  business_id            text not null references businesses (id) on delete cascade,
  id                     text not null,
  type                   text not null check (type in ('invoice', 'bill', 'recurring', 'sales_deal', 'purchase_order', 'plan')),
  party_id               text,
  amount                 bigint not null,          -- original total
  currency               text not null check (char_length(currency) = 3),
  anchors                jsonb not null default '{}'::jsonb,
  pattern_id             text,
  status                 text not null check (status in ('actual', 'committed', 'likely', 'possible')),
  probability            double precision check (probability between 0 and 1),
  discount               jsonb,                    -- { pct, byDate }
  linked_commitment_ids  text[] not null default '{}',
  outstanding            bigint,                   -- remaining after partial settlements
  settlement             text check (settlement in ('open', 'partial', 'paid', 'cancelled', 'credited')),
  invoice_url            text,
  payment_url            text,                     -- never evidence of payment
  evidence_ids           text[] not null default '{}',
  source_ref             jsonb not null,
  source_system          text generated always as (source_ref ->> 'system') stored,
  source_record          text generated always as (source_ref ->> 'record') stored,
  created_at             timestamptz not null default now(),
  primary key (business_id, id),
  check (status <> 'possible' or probability is not null)
);
-- One commitment per source record: re-importing an export is a no-op.
create unique index commitments_source_key on commitments (business_id, source_system, source_record);
create index commitments_party on commitments (business_id, party_id);

-- Actual (in-the-bank) movements only. Future events are computed by the engine.
create table cash_events (
  business_id    text not null references businesses (id) on delete cascade,
  id             text not null,
  commitment_id  text not null,
  leg_index      integer not null default 0,
  date           date not null,
  amount         bigint not null,
  currency       text not null check (char_length(currency) = 3),
  amount_base    bigint not null,
  direction      text not null check (direction in ('in', 'out')),
  status         text not null check (status in ('actual', 'committed', 'likely', 'possible')),
  confidence     double precision not null check (confidence between 0 and 1),
  basis          text not null,
  source_ref     jsonb not null,
  source_system  text generated always as (source_ref ->> 'system') stored,
  source_record  text generated always as (source_ref ->> 'record') stored,
  overridden_by  text[],
  created_at     timestamptz not null default now(),
  primary key (business_id, id)
);
create index cash_events_date on cash_events (business_id, date);

create table signals (
  business_id     text not null references businesses (id) on delete cascade,
  id              text not null,
  channel         text not null check (channel in ('email', 'whatsapp', 'crm', 'owner')),
  received_at     timestamptz not null,
  party_id        text,
  commitment_ref  text,
  claim           jsonb not null,   -- SignalClaim
  confidence      double precision not null check (confidence between 0 and 1),
  effect          jsonb,            -- { lowPointDelta, week }, filled by the engine
  state           text not null default 'proposed' check (state in ('proposed', 'applied', 'dismissed')),
  source_ref      jsonb not null,
  source_system   text generated always as (source_ref ->> 'system') stored,
  source_record   text generated always as (source_ref ->> 'record') stored,
  created_at      timestamptz not null default now(),
  primary key (business_id, id)
);

create table rules (
  business_id  text not null references businesses (id) on delete cascade,
  id           text not null,
  scope        jsonb not null,    -- { partyId } | { all: true }
  kind         text not null check (kind in ('lag_offset', 'preference', 'flexibility')),
  params       jsonb not null default '{}'::jsonb,
  from_note    text not null,
  confirmed    boolean not null default false,
  created_at   timestamptz not null default now(),
  primary key (business_id, id)
);

create table work_items (
  business_id     text not null references businesses (id) on delete cascade,
  id              text not null,
  warning         text not null,
  title           text not null,
  why             text not null,
  lever           jsonb,
  cash_effect     bigint not null,  -- from simulate(), never from Claude
  needed_by       date not null,
  confidence      double precision not null check (confidence between 0 and 1),
  score           double precision not null,
  evidence_refs   text[] not null default '{}',
  actions         jsonb not null default '[]'::jsonb,
  partner_action  jsonb,
  state           text not null default 'open' check (state in ('open', 'done', 'dismissed')),
  created_at      timestamptz not null default now(),
  primary key (business_id, id)
);

create table settlements (
  business_id    text not null references businesses (id) on delete cascade,
  id             text not null,
  commitment_id  text not null,
  party_id       text,
  amount         bigint not null,
  currency       text not null check (char_length(currency) = 3),
  date           date not null,
  source_ref     jsonb not null,
  source_system  text generated always as (source_ref ->> 'system') stored,
  source_record  text generated always as (source_ref ->> 'record') stored,
  created_at     timestamptz not null default now(),
  primary key (business_id, id)
);
create index settlements_commitment on settlements (business_id, commitment_id);

create table balance_snapshots (
  business_id    text not null references businesses (id) on delete cascade,
  id             text not null,
  account        text not null,
  amount         bigint not null,   -- may be negative
  currency       text not null check (char_length(currency) = 3),
  as_of          date not null,
  source_ref     jsonb not null,
  source_system  text generated always as (source_ref ->> 'system') stored,
  source_record  text generated always as (source_ref ->> 'record') stored,
  created_at     timestamptz not null default now(),
  primary key (business_id, id)
);
create index balance_snapshots_as_of on balance_snapshots (business_id, as_of);

create table evidence (
  business_id    text not null references businesses (id) on delete cascade,
  id             text not null,
  channel        text not null check (channel in ('zoho_books', 'bank_csv', 'email', 'whatsapp', 'upload', 'url', 'owner')),
  format         text not null check (format in ('csv', 'xlsx', 'pdf', 'text', 'html', 'api')),
  received_at    timestamptz not null,
  parent_id      text,
  file_hash      text,
  url            text,
  extraction     text not null check (extraction in ('ok', 'partial', 'unreadable', 'unsupported')),
  commitment_id  text,              -- set only after the owner confirms the link
  source_ref     jsonb not null,
  source_system  text generated always as (source_ref ->> 'system') stored,
  source_record  text generated always as (source_ref ->> 'record') stored,
  created_at     timestamptz not null default now(),
  primary key (business_id, id)
);
create unique index evidence_source_key on evidence (business_id, source_system, source_record);
create index evidence_file_hash on evidence (business_id, file_hash) where file_hash is not null;
create index evidence_commitment on evidence (business_id, commitment_id) where commitment_id is not null;

create table scenarios (
  business_id  text not null references businesses (id) on delete cascade,
  id           text not null,       -- 'base', 'stress', or a what-if id
  kind         text not null check (kind in ('base', 'stress', 'what_if')),
  overrides    jsonb not null default '[]'::jsonb,  -- Override[]
  levers       jsonb,                               -- Lever[]
  created_at   timestamptz not null default now(),
  primary key (business_id, id)
);

-- Snapshot of each run, so a change alert can say what moved.
create table forecast_runs (
  business_id  text not null references businesses (id) on delete cascade,
  id           text not null,
  scenario_id  text not null,
  as_of        date not null,
  inputs_hash  text not null,
  run          jsonb not null,      -- the full ForecastRun
  created_at   timestamptz not null default now(),
  primary key (business_id, id)
);
create index forecast_runs_lookup on forecast_runs (business_id, scenario_id, inputs_hash);

-- schema/intake.ts DocumentCandidate: extraction output awaiting reconciliation.
create table document_candidates (
  business_id       text not null references businesses (id) on delete cascade,
  id                text not null,
  evidence_ids      text[] not null default '{}',
  kind              text not null check (kind in ('invoice', 'bill', 'purchase_order', 'payment_evidence', 'conversational_update', 'none')),
  direction         text check (direction in ('in', 'out')),
  fields            jsonb not null,  -- CandidateFields: found / missing / conflict per field
  party_id          text,
  party_candidates  jsonb,
  confidence        double precision not null check (confidence between 0 and 1),
  extraction        text not null check (extraction in ('ok', 'partial', 'unreadable', 'unsupported')),
  notes             text[] not null default '{}',
  created_at        timestamptz not null default now(),
  primary key (business_id, id)
);

-- schema/intake.ts ProposedUpdate: what the Review screen shows. Only a confirmed
-- proposal may change commitments or evidence.
create table proposed_updates (
  business_id           text not null references businesses (id) on delete cascade,
  id                    text not null,
  action                text not null check (action in ('create', 'link', 'update', 'conflict', 'review')),
  candidate_id          text,
  signal_id             text,
  evidence_ids          text[] not null default '{}',
  target_commitment_id  text,
  match_candidates      text[],
  draft                 jsonb,
  changes               jsonb not null default '[]'::jsonb,
  reasons               text[] not null default '{}',
  conflicts             text[] not null default '{}',
  state                 text not null default 'proposed' check (state in ('proposed', 'confirmed', 'dismissed')),
  created_at            timestamptz not null default now(),
  decided_at            timestamptz,
  primary key (business_id, id)
);
create index proposed_updates_open on proposed_updates (business_id) where state = 'proposed';

-- Learned spreadsheet layouts, keyed by a hash of the header row (docs/design/04-adapters.md).
create table column_mappings (
  business_id  text not null references businesses (id) on delete cascade,
  header_hash  text not null,
  source       text not null,       -- adapter id
  mapping      jsonb not null,
  confirmed    boolean not null default false,
  created_at   timestamptz not null default now(),
  primary key (business_id, header_hash)
);

-- Real name -> stage name, for masking in demo mode.
create table aliases (
  business_id  text not null references businesses (id) on delete cascade,
  real_name    text not null,
  stage_name   text not null,
  created_at   timestamptz not null default now(),
  primary key (business_id, real_name)
);

-- ---------------------------------------------------------------------------
-- Row level security
--
-- HACKATHON ONLY. Every table has RLS enabled. The policies below let the anon
-- and authenticated keys read and write rows that belong to synthetic
-- (is_synthetic = true) businesses, so the whole team can share one hosted
-- project with fixture data. Rows of non-synthetic businesses are reachable
-- only with the service-role key, which bypasses RLS and must stay server-side.
--
-- Before any real business data goes into a hosted project, replace these with
-- per-user/per-business policies tied to auth.uid(). Real PilotCo data stays
-- local (data/private/, see CLAUDE.md) until then.
-- ---------------------------------------------------------------------------

alter table businesses enable row level security;

create policy hackathon_synthetic_businesses on businesses
  for all to anon, authenticated
  using (is_synthetic)
  with check (is_synthetic);

do $$
declare
  t text;
begin
  foreach t in array array[
    'parties', 'commitments', 'cash_events', 'signals', 'rules', 'work_items',
    'settlements', 'balance_snapshots', 'evidence', 'scenarios', 'forecast_runs',
    'document_candidates', 'proposed_updates', 'column_mappings', 'aliases'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format($p$
      create policy hackathon_synthetic_only on %I
        for all to anon, authenticated
        using (exists (select 1 from businesses b where b.id = business_id and b.is_synthetic))
        with check (exists (select 1 from businesses b where b.id = business_id and b.is_synthetic))
    $p$, t);
  end loop;
end
$$;
