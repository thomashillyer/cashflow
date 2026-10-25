-- Member confirmations (issue #127, from #122). Must be applied AFTER
-- 20261025160000_tenant_access.sql (it uses public.is_member and public.memberships).
-- Two changes: confirm_change_proposal accepts members, and create_business validates its
-- profile (second function at the end of this file).
--
-- confirm_change_proposal() accepted only synthetic businesses or the service role, so a real
-- owner (a member of a private business) could never confirm a proposal. Same body as
-- 20261025120000_init_records.sql with one change: the business scope check also accepts
-- public.is_member(id), i.e. a signed-in user who belongs to the business.
--
-- Every other check is unchanged: argument validation, per-business lock, idempotent replay,
-- business and candidate revisions, pending state, unresolved actions, NOT_IMPLEMENTED for ops.
-- The scope check stays part of the locking WHERE, so a non-member cannot even take a lock on a
-- private business and gets NOT_FOUND (PT404), the same as for an unknown business.
--
-- load_records() needs no change: 20261025160000_tenant_access.sql already lets members load
-- their own business (verified together with this migration).
-- Grants are unchanged: anon, authenticated and service_role may execute (re-asserted below).
-- Any membership role (owner, admin, member) may confirm. Today only owners exist (no invite
-- path yet); decide whether plain members stay read-only when invites land.

-- Fail loudly at apply time if the tenant-access migration is missing: plpgsql does not check
-- function references at create time, so without this the migration would apply and every
-- confirmation (synthetic and service callers too) would then fail at run time.
do $$
begin
  if to_regprocedure('public.is_member(text)') is null or to_regclass('public.memberships') is null then
    raise exception 'apply 20261025160000_tenant_access.sql first';
  end if;
end
$$;

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
  -- non-service, non-member caller cannot even take a lock on a non-synthetic business.
  select store_revision into v_revision from public.businesses
   where id = p_business_id
     and (is_synthetic or public.is_service_caller() or public.is_member(id))
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

revoke all on function public.confirm_change_proposal(text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.confirm_change_proposal(text, text, bigint, text) to anon, authenticated, service_role;

-- create_business: validate the profile. 20261025160000 accepted any jsonb (an array, a JSON
-- null, a multi-megabyte string), so any signed-in user (including anonymous sign-ins) could
-- store 5 arbitrarily large rows. The profile must be a JSON object of at most 64 KB. Otherwise
-- the body is the same as in 20261025160000; grants are unchanged.
create or replace function public.create_business(p_name text, p_profile jsonb default '{}'::jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_id   text;
  v_name text := btrim(coalesce(p_name, ''));
  v_profile jsonb := coalesce(p_profile, '{}'::jsonb);
begin
  if v_user is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  if v_name = '' or length(v_name) > 120
     or jsonb_typeof(v_profile) <> 'object' or octet_length(v_profile::text) > 65536 then
    raise exception 'INVALID_ARGUMENT' using errcode = 'PT400';
  end if;
  -- Serialize per user so parallel calls can't both pass the limit.
  perform pg_advisory_xact_lock(hashtext(v_user::text));
  if (select count(*) from public.memberships m where m.user_id = v_user and m.role = 'owner') >= 5 then
    raise exception 'TOO_MANY_BUSINESSES' using errcode = 'PT429';
  end if;

  v_id := 'biz-' || substr(md5(gen_random_uuid()::text), 1, 16);
  insert into public.businesses (id, name, profile, is_synthetic)
  values (v_id, v_name, v_profile, false);
  insert into public.memberships (business_id, user_id, role)
  values (v_id, v_user, 'owner');
  return v_id;
end
$$;

revoke all on function public.create_business(text, jsonb) from public, anon, authenticated;
grant execute on function public.create_business(text, jsonb) to authenticated, service_role;
