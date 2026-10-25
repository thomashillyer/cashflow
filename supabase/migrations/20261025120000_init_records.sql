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
  -- expose synthetic businesses to the anon/authenticated keys (read-only).
  -- Fails closed: a business is private unless fixture/demo seeding (service role)
  -- sets is_synthetic = true explicitly.
  is_synthetic  boolean not null default false,
  -- Monotonic business revision. Every confirmed change and profile edit bumps it;
  -- proposals carry the revision they were computed against (docs/TECHNICAL_PLAN.md section 4).
  store_revision  bigint not null default 0,
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
  -- SourceRef[]: provider ids, the upsert key for parties. No unique index yet: an index
  -- over every element needs a generated array column, and generated columns cannot
  -- unnest jsonb. Parties are deduplicated in code until provider_links exists (TECHNICAL_PLAN s4).
  source_refs  jsonb,
  aliases      text[],  -- other confirmed display names
  created_at   timestamptz not null default now(),
  primary key (business_id, id)
);

create table commitments (
  business_id            text not null references businesses (id) on delete cascade,
  id                     text not null,
  type                   text not null check (type in ('invoice', 'bill', 'recurring', 'sales_deal', 'purchase_order', 'plan')),
  direction              text check (direction in ('in', 'out')),
  reference              text,                     -- document number; not globally unique
  category               text,
  funding                boolean,                  -- true for loans/financing (TS: funding?: true)
  party_id               text,
  amount                 bigint not null,          -- original total
  currency               text not null check (char_length(currency) = 3),
  anchors                jsonb not null default '{}'::jsonb,
  pattern_id             text,
  status                 text not null check (status in ('actual', 'committed', 'likely', 'possible')),
  probability            double precision check (probability between 0 and 1),
  discount               jsonb,                    -- { pct, byDate }
  linked_commitment_ids  text[] default '{}',  -- nullable so bulk upserts that omit it do not fail
  outstanding            bigint,                   -- remaining after partial settlements
  settlement             text check (settlement in ('open', 'partial', 'paid', 'cancelled', 'credited')),
  invoice_url            text,
  payment_url            text,                     -- never evidence of payment
  evidence_ids           text[] default '{}',  -- nullable, see linked_commitment_ids
  source_ref             jsonb not null,
  source_system          text generated always as (source_ref ->> 'system') stored,
  source_record          text generated always as (source_ref ->> 'record') stored,
  created_at             timestamptz not null default now(),
  primary key (business_id, id),
  check (status <> 'possible' or probability is not null)
);
-- One commitment per source record: re-importing an export is a no-op. Partial: only
-- adapter systems have stable record ids that identify a commitment. Message and owner
-- sources (email, whatsapp, owner, ...) may legitimately point several commitments at one record.
create unique index commitments_source_key on commitments (business_id, source_system, source_record)
  where source_system in ('zoho_books', 'bank_csv', 'generic_file');
create index commitments_party on commitments (business_id, party_id);
-- Reconciliation lookup: same party + reference (then type/direction/currency in code).
create index commitments_reference on commitments (business_id, party_id, reference) where reference is not null;

-- Actual (in-the-bank) movements only. Future events are computed by the engine.
-- amount_base / confidence / basis may be null on stored actuals; the engine fills them per run.
create table cash_events (
  business_id    text not null references businesses (id) on delete cascade,
  id             text not null,
  commitment_id  text,              -- null for unmatched bank actuals (card sales, fees)
  leg_index      integer not null default 0,
  date           date not null,
  amount         bigint not null,
  currency       text not null check (char_length(currency) = 3),
  amount_base    bigint,
  direction      text not null check (direction in ('in', 'out')),
  status         text not null check (status in ('actual', 'committed', 'likely', 'possible')),
  confidence     double precision check (confidence between 0 and 1),
  basis          text,
  category       text,
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
  commitment_id     text,
  match_candidates  jsonb,          -- { commitmentId, reasons[] }[] when ambiguous
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
  state        text not null default 'proposed' check (state in ('proposed', 'confirmed', 'dismissed')),
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
  leg_index      integer,           -- which pattern leg this pays, when known
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
  channel        text not null check (channel in ('zoho_books', 'bank_csv', 'email', 'whatsapp', 'crm', 'upload', 'url', 'owner')),
  format         text not null check (format in ('csv', 'xlsx', 'pdf', 'text', 'eml', 'html', 'image', 'api')),
  received_at    timestamptz not null,
  parent_id      text,
  file_name      text,
  mime           text,
  storage_key    text,              -- where the original bytes live
  file_hash      text,
  url            text,
  text           text,              -- extracted text (bounded)
  extraction     text not null check (extraction in ('ok', 'partial', 'unreadable', 'unsupported')),
  -- Links to commitments live only in commitments.evidence_ids.
  source_ref     jsonb not null,
  source_system  text generated always as (source_ref ->> 'system') stored,
  source_record  text generated always as (source_ref ->> 'record') stored,
  created_at     timestamptz not null default now(),
  primary key (business_id, id)
);
create unique index evidence_source_key on evidence (business_id, source_system, source_record);
create index evidence_file_hash on evidence (business_id, file_hash) where file_hash is not null;
create index commitments_evidence on commitments using gin (evidence_ids);

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

-- schema/intake.ts IntakeCandidate: extraction output awaiting reconciliation.
create table intake_candidates (
  business_id         text not null references businesses (id) on delete cascade,
  id                  text not null,
  revision            integer not null default 1,
  extraction_version  text not null,
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

-- schema/intake.ts ChangeProposal: what the Review screen shows. Only a confirmed
-- proposal may change records, through confirm_change_proposal() below.
create table change_proposals (
  business_id              text not null references businesses (id) on delete cascade,
  id                       text not null,
  action                   text not null check (action in ('create', 'link', 'update', 'conflict', 'review')),
  ops                      jsonb not null default '[]'::jsonb check (jsonb_typeof(ops) = 'array'),  -- ProposalOp[], applied together
  candidate_id             text,
  candidate_revision       integer,
  expected_store_revision  bigint not null,
  evidence_ids             text[] not null default '{}',
  target_commitment_id     text,
  match_candidates         jsonb,          -- { commitmentId, reasons[] }[]
  reasons                  text[] not null default '{}',
  conflicts                jsonb not null default '[]'::jsonb,  -- { field, values[] }[]
  owner_edits              jsonb,          -- CommitmentFieldChange[]
  state                    text not null default 'proposed' check (state in ('proposed', 'confirmed', 'dismissed')),
  source_ref               jsonb,
  created_at               timestamptz not null default now(),  -- ChangeProposal.createdAt
  decided_at               timestamptz,
  primary key (business_id, id)
);
create index change_proposals_open on change_proposals (business_id) where state = 'proposed';

-- Idempotency for confirmations: the same key replays the stored result.
create table mutations (
  business_id      text not null references businesses (id) on delete cascade,
  idempotency_key  text not null,
  proposal_id      text not null,
  -- md5(proposal_id || ':' || expected_revision). Same key + different digest is an
  -- IDEMPOTENCY_CONFLICT (docs/TECHNICAL_PLAN.md s4 step 2).
  request_digest   text not null,
  result           jsonb not null,
  created_at       timestamptz not null default now(),
  primary key (business_id, idempotency_key)
);

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
-- Access model (HACKATHON ONLY)
--
--   * Row level security is enabled on every table.
--   * anon / authenticated may only SELECT rows of synthetic businesses (is_synthetic).
--     They have no insert/update/delete grant or policy, and cannot create businesses.
--     aliases (real name -> stage name) and mutations get no anon/authenticated
--     policy at all.
--   * Writes happen through the service role (server side only; it bypasses RLS and
--     must never reach the browser) or through the SECURITY DEFINER functions below.
--   * The SECURITY DEFINER functions re-check that non-service callers only touch
--     synthetic businesses. They run as the migration owner, so they bypass RLS and
--     do their own scoping. search_path is empty and every name is schema-qualified,
--     so a caller cannot shadow a table or function.
--
-- Later migrations: new tables and functions are NOT reachable by anon/authenticated
-- (the default privileges are revoked at the end of this file). Every new table needs an
-- explicit grant select plus a hackathon_read_synthetic-style policy, and every new RPC
-- needs an explicit grant execute and its own synthetic-scope check.
--
-- Anyone holding the public anon key can still call confirm_change_proposal on a
-- synthetic business, so one visitor can confirm another visitor's pending proposals.
-- Per-session isolation (docs/TECHNICAL_PLAN.md section 9) is a TODO. Before any real
-- business data goes into a hosted project, replace this with per-user/per-business
-- policies tied to auth.uid(). Real PilotCo data stays local (data/private/).
-- ---------------------------------------------------------------------------

-- True when the request was made with the service-role key. PostgREST puts the JWT
-- claims in request.jwt.claims for every request (what auth.role() reads on Supabase).
-- No claims (a direct database connection) counts as not service: fail closed.
create or replace function public.is_service_caller() returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
$$;

alter table public.businesses enable row level security;

create policy hackathon_read_synthetic on public.businesses
  for select to anon, authenticated
  using (is_synthetic);

do $$
declare
  t text;
begin
  foreach t in array array[
    'parties', 'commitments', 'cash_events', 'signals', 'rules', 'work_items',
    'settlements', 'balance_snapshots', 'evidence', 'scenarios', 'forecast_runs',
    'intake_candidates', 'change_proposals', 'column_mappings'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format($p$
      create policy hackathon_read_synthetic on public.%I
        for select to anon, authenticated
        using (exists (select 1 from public.businesses b where b.id = business_id and b.is_synthetic))
    $p$, t);
  end loop;
end
$$;

-- RLS on, no policy for anon/authenticated: only the service role and the
-- SECURITY DEFINER functions can touch these.
alter table public.mutations enable row level security;
alter table public.aliases enable row level security;

-- ---------------------------------------------------------------------------
-- Snapshot read (docs/TECHNICAL_PLAN.md section 4: "snapshot reads"). One statement,
-- so every collection and the revision come from the same MVCC snapshot, and no
-- PostgREST row limit truncates a collection. Keys match db/rows.ts TABLES (the
-- schema/records.ts Records shape); rows are to_jsonb(row) with snake_case columns.
-- Errors: NOT_FOUND (PT404) for an unknown business, or a non-synthetic one for a
-- non-service caller.
-- ---------------------------------------------------------------------------
create or replace function public.load_records(p_business_id text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_snapshot jsonb;
begin
  select jsonb_build_object(
    'storeRevision', b.store_revision,
    'records', jsonb_build_object(
      'parties',     coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.parties t where t.business_id = b.id), '[]'::jsonb),
      'commitments', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.commitments t where t.business_id = b.id), '[]'::jsonb),
      'events',      coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.cash_events t where t.business_id = b.id), '[]'::jsonb),
      'signals',     coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.signals t where t.business_id = b.id), '[]'::jsonb),
      'rules',       coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.rules t where t.business_id = b.id), '[]'::jsonb),
      'settlements', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.settlements t where t.business_id = b.id), '[]'::jsonb),
      'balances',    coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.balance_snapshots t where t.business_id = b.id), '[]'::jsonb),
      'evidence',    coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.evidence t where t.business_id = b.id), '[]'::jsonb)
    )
  ) into v_snapshot
  from public.businesses b
  where b.id = p_business_id
    and (b.is_synthetic or public.is_service_caller());

  if v_snapshot is null then
    raise exception 'NOT_FOUND' using errcode = 'PT404';
  end if;
  return v_snapshot;
end
$$;

-- ---------------------------------------------------------------------------
-- Atomic confirmation (docs/TECHNICAL_PLAN.md section 4). Call through
-- supabase.rpc('confirm_change_proposal', {...}); one call = one transaction.
--
-- Errors carry the code name as the message and a custom SQLSTATE. PostgREST maps
-- SQLSTATE PTxyz to HTTP status xyz, so clients get the right status:
--   PT409  STALE_REVIEW            business revision or candidate revision moved
--   PT409  IDEMPOTENCY_CONFLICT    same key reused for a different request digest
--   PT409  PROPOSAL_NOT_PENDING    proposal already confirmed or dismissed
--   PT409  PROPOSAL_UNRESOLVED     action conflict/review: the owner must resolve it first
--   PT404  NOT_FOUND               unknown (or, for non-service callers, non-synthetic)
--                                  business, proposal or candidate
--   PT501  NOT_IMPLEMENTED         proposal has ops, which this function cannot apply yet
--   PT400  INVALID_ARGUMENT        a null argument
--
-- STATUS: VALIDATE-AND-LOCK ONLY. Applying proposal ops is not implemented, so every
-- proposal that would change records (ops non-empty) is rejected with NOT_IMPLEMENTED
-- and nothing is written. Only a proposal with zero ops passes, and then it merely
-- records the decision. Never report success for ops that were not applied.
-- ---------------------------------------------------------------------------
create or replace function public.confirm_change_proposal(
  p_business_id text,
  p_proposal_id text,
  p_expected_revision bigint,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_revision bigint;
  v_digest text;
  v_prior public.mutations%rowtype;
  v_proposal public.change_proposals%rowtype;
  v_candidate_revision integer;
  v_result jsonb;
begin
  if p_business_id is null or p_proposal_id is null or p_expected_revision is null or p_idempotency_key is null then
    raise exception 'INVALID_ARGUMENT' using errcode = 'PT400';
  end if;
  v_digest := md5(p_proposal_id || ':' || p_expected_revision);

  -- Serialize confirmations per business. The scope check is part of the WHERE so a
  -- non-service caller cannot even take a lock on a non-synthetic business.
  select store_revision into v_revision from public.businesses
   where id = p_business_id
     and (is_synthetic or public.is_service_caller())
   for no key update;  -- not "for update": that would block child-table inserts (FK key share locks)
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'PT404';
  end if;

  -- Replay a completed identical mutation before checking revisions. Checked under the
  -- lock so a concurrent retry with the same key replays instead of failing as stale.
  select * into v_prior from public.mutations
   where business_id = p_business_id and idempotency_key = p_idempotency_key;
  if found then
    if v_prior.request_digest <> v_digest then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'PT409';
    end if;
    return v_prior.result || jsonb_build_object('replayed', true);
  end if;

  if v_revision <> p_expected_revision then
    raise exception 'STALE_REVIEW' using errcode = 'PT409';
  end if;

  select * into v_proposal from public.change_proposals
   where business_id = p_business_id and id = p_proposal_id
   for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'PT404';
  end if;
  if v_proposal.state <> 'proposed' then
    raise exception 'PROPOSAL_NOT_PENDING' using errcode = 'PT409';
  end if;
  -- The proposal itself was computed against an older business revision.
  if v_proposal.expected_store_revision <> v_revision then
    raise exception 'STALE_REVIEW' using errcode = 'PT409';
  end if;
  if v_proposal.action in ('conflict', 'review') then
    raise exception 'PROPOSAL_UNRESOLVED' using errcode = 'PT409';
  end if;

  -- The candidate was re-extracted after the proposal was built.
  if v_proposal.candidate_id is not null then
    select revision into v_candidate_revision from public.intake_candidates
     where business_id = p_business_id and id = v_proposal.candidate_id
     for update;
    if not found then
      raise exception 'NOT_FOUND' using errcode = 'PT404';
    end if;
    if v_candidate_revision is distinct from v_proposal.candidate_revision then
      raise exception 'STALE_REVIEW' using errcode = 'PT409';
    end if;
  end if;

  -- TODO (persons 3/5): apply change_proposals.ops here, inside this transaction, and
  -- then delete the NOT_IMPLEMENTED guard below:
  --   createParty / createCommitment (resolve tempIds), linkEvidence (append to
  --   commitments.evidence_ids), linkCommitments (PO allocation), updateCommitment
  --   (allowlisted fields only; never settlement), createSettlement. Fill
  --   affectedRecordIds in the result.
  -- Until then, refuse instead of recording a confirmation whose ops were never applied.
  if jsonb_array_length(v_proposal.ops) > 0 then
    raise exception 'NOT_IMPLEMENTED' using errcode = 'PT501';
  end if;

  update public.change_proposals
     set state = 'confirmed', decided_at = now()
   where business_id = p_business_id and id = p_proposal_id;

  update public.businesses
     set store_revision = store_revision + 1
   where id = p_business_id
  returning store_revision into v_revision;

  v_result := jsonb_build_object(
    'operationId', p_idempotency_key,
    'replayed', false,
    'storeRevision', v_revision,
    'affectedRecordIds', '[]'::jsonb,
    'warnings', '[]'::jsonb
  );
  insert into public.mutations (business_id, idempotency_key, proposal_id, request_digest, result)
  values (p_business_id, p_idempotency_key, p_proposal_id, v_digest, v_result);
  return v_result;
end
$$;

-- Direct writes (adapter imports, fixture seeding) bypass confirm_change_proposal, so
-- they must advance the business revision themselves or open proposals would not go
-- stale. Service role only. Returns the new revision.
create or replace function public.bump_store_revision(p_business_id text) returns bigint
language plpgsql security definer
set search_path = ''
as $$
declare
  v_revision bigint;
begin
  if not public.is_service_caller() then
    raise exception 'FORBIDDEN' using errcode = 'PT403';
  end if;
  update public.businesses
     set store_revision = store_revision + 1
   where id = p_business_id
  returning store_revision into v_revision;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'PT404';
  end if;
  return v_revision;
end
$$;

-- ---------------------------------------------------------------------------
-- Explicit grants. Supabase's default privileges give anon/authenticated ALL on new
-- public tables and EXECUTE on new functions, so take everything away first and add back
-- only what is intended. Do not rely on the defaults.
-- ---------------------------------------------------------------------------
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges revoke execute on functions from public;

revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated, service_role;
grant select on all tables in schema public to anon, authenticated;
revoke select on public.aliases, public.mutations from anon, authenticated;
grant all on all tables in schema public to service_role;

revoke all on function public.is_service_caller() from public, anon, authenticated;
revoke all on function public.load_records(text) from public, anon, authenticated;
revoke all on function public.confirm_change_proposal(text, text, bigint, text) from public, anon, authenticated;
revoke all on function public.bump_store_revision(text) from public, anon, authenticated;
grant execute on function public.load_records(text) to anon, authenticated, service_role;
grant execute on function public.confirm_change_proposal(text, text, bigint, text) to anon, authenticated, service_role;
grant execute on function public.bump_store_revision(text) to service_role;
