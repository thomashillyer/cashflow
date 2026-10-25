-- Atomic, idempotent owner decisions (issue #191).
-- "Code computes, the DB commits": the API computes a confirm / dismiss / signal decision in TypeScript
-- and hands the finished rows to commit_review_decision, which writes them, the proposal states, the
-- revision bump and the stored response in ONE transaction. A compare-and-set on store_revision stops
-- a double click or a second tab from applying the same decision twice; the idempotency key lets the
-- same request be replayed safely. confirm_change_proposal is left as it was.

create table public.review_decisions (
  business_id      text not null references public.businesses (id) on delete cascade,
  idempotency_key  text not null,
  request_hash     text not null,
  response         jsonb not null,
  created_at       timestamptz not null default now(),
  primary key (business_id, idempotency_key)
);

-- RLS on, no policy for anon/authenticated: only the service role and the SECURITY DEFINER function.
alter table public.review_decisions enable row level security;

create or replace function public.commit_review_decision(
  p_business_id text, p_key text, p_hash text, p_expected_revision bigint, p_rows jsonb, p_response jsonb
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  -- Every table here has the primary key (business_id, id) (see the init migration).
  v_allowed constant text[] := array[
    'parties', 'commitments', 'cash_events', 'signals', 'rules', 'settlements',
    'balance_snapshots', 'evidence', 'change_proposals'
  ];
  v_revision bigint;
  v_new_revision bigint;
  v_prior public.review_decisions%rowtype;
  v_table text;
  v_rows jsonb;
  v_cols text[];
  v_unknown text;
  v_col_list text;
  v_set_list text;
  v_response jsonb;
begin
  if not public.is_service_caller() then
    raise exception 'FORBIDDEN' using errcode = 'PT403';
  end if;
  if p_key is null or p_key = '' or p_hash is null or p_hash = ''
     or p_rows is null or jsonb_typeof(p_rows) <> 'object' then
    raise exception 'INVALID_ARGUMENT' using errcode = 'PT400';
  end if;

  -- 1. Serialize decisions per business.
  select store_revision into v_revision from public.businesses where id = p_business_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'PT404';
  end if;

  -- 2. Idempotency first: a replay succeeds even though the revision has moved since.
  select * into v_prior from public.review_decisions
   where business_id = p_business_id and idempotency_key = p_key;
  if found then
    if v_prior.request_hash = p_hash then
      return jsonb_build_object('kind', 'replay', 'response', v_prior.response);
    end if;
    return jsonb_build_object('kind', 'conflict');
  end if;

  -- 3. Compare-and-set on the revision the request loaded.
  if v_revision <> p_expected_revision then
    return jsonb_build_object('kind', 'stale', 'storeRevision', v_revision);
  end if;

  -- 4. Upsert each table's rows (already in column shape). Only the columns the rows carry are
  --    written, so omitted columns keep their value / take their default (as upsertRecords does).
  for v_table, v_rows in select key, value from jsonb_each(p_rows) loop
    if not (v_table = any (v_allowed)) or jsonb_typeof(v_rows) <> 'array' then
      raise exception 'INVALID_ARGUMENT' using errcode = 'PT400';
    end if;
    if jsonb_array_length(v_rows) = 0 then
      continue;
    end if;

    select array_agg(distinct k order by k) into v_cols
      from jsonb_array_elements(v_rows) e, jsonb_object_keys(e) k
     where k not in ('business_id', 'id');

    -- Reject keys that are not real columns instead of dropping them silently.
    select k into v_unknown
      from unnest(coalesce(v_cols, array[]::text[])) k
     where not exists (
       select 1 from information_schema.columns c
        where c.table_schema = 'public' and c.table_name = v_table and c.column_name = k)
     limit 1;
    if v_unknown is not null then
      raise exception 'INVALID_ARGUMENT' using errcode = 'PT400';
    end if;

    select string_agg(format('%I', k), ', '), string_agg(format('%I = excluded.%I', k, k), ', ')
      into v_col_list, v_set_list
      from unnest(coalesce(v_cols, array[]::text[])) k;

    if v_col_list is null then
      execute format(
        'insert into public.%I (business_id, id) select $1, r.id from jsonb_populate_recordset(null::public.%I, $2) r on conflict (business_id, id) do nothing',
        v_table, v_table) using p_business_id, v_rows;
    else
      execute format(
        'insert into public.%I (business_id, id, %s) select $1, r.id, %s from jsonb_populate_recordset(null::public.%I, $2) r on conflict (business_id, id) do update set %s',
        v_table, v_col_list, (select string_agg('r.' || format('%I', k), ', ') from unnest(v_cols) k), v_table, v_set_list)
        using p_business_id, v_rows;
    end if;
  end loop;

  -- 5. Bump the revision so every other open proposal and tab goes stale.
  update public.businesses set store_revision = store_revision + 1
   where id = p_business_id returning store_revision into v_new_revision;

  -- 6. Remember the decision and what we answered.
  v_response := coalesce(p_response, '{}'::jsonb) || jsonb_build_object('storeRevision', v_new_revision);
  insert into public.review_decisions (business_id, idempotency_key, request_hash, response)
  values (p_business_id, p_key, p_hash, v_response);

  -- 7.
  return jsonb_build_object('kind', 'ok', 'storeRevision', v_new_revision, 'response', v_response);
end
$$;

revoke all on function public.commit_review_decision(text, text, text, bigint, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.commit_review_decision(text, text, text, bigint, jsonb, jsonb) to service_role;
