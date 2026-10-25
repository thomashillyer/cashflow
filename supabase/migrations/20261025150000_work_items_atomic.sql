-- Atomic work-item save (follow-up to 20261025130000, issue #91). Additive only.
--
-- 1. businesses.work_items_inputs_hash: the ForecastRun.inputsHash the saved ranking came from,
--    kept per business so a business whose ranking is empty (no rows) still reads as current.
--    Nullable: null means "never saved". work_items.inputs_hash stays for compatibility.
-- 2. save_work_items: upsert + prune + stamp in ONE transaction, serialized per business, so two
--    concurrent saves cannot interleave and a failure part-way leaves nothing changed.
--    Service role only (same pattern as bump_store_revision).
alter table public.businesses add column if not exists work_items_inputs_hash text;

-- p_items: jsonb array of work-item rows keyed by snake_case column name (the camelCase WorkItem
-- fields converted, without state and business_id). A `state` key is ignored: new rows take the
-- default 'open' and existing rows keep theirs, so a recompute cannot undo an owner's tick-off.
-- Open items missing from p_items are deleted; done and dismissed items are kept. Every remaining
-- row and the business are stamped with p_inputs_hash. Returns the number of items upserted.
-- Errors: FORBIDDEN (PT403), NOT_FOUND (PT404, unknown business), INVALID_ARGUMENT (PT400).
create or replace function public.save_work_items(p_business_id text, p_items jsonb, p_inputs_hash text)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ids   text[];
  v_count integer;
begin
  if not public.is_service_caller() then
    raise exception 'FORBIDDEN' using errcode = 'PT403';
  end if;
  if p_inputs_hash is null or p_inputs_hash = ''
     or p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'INVALID_ARGUMENT' using errcode = 'PT400';
  end if;

  -- Serialize saves for this business. NO KEY UPDATE conflicts with itself (and with
  -- bump_store_revision) but not with the key-share locks child-row inserts take.
  perform 1 from public.businesses where id = p_business_id for no key update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'PT404';
  end if;

  select coalesce(array_agg(i.id), '{}'::text[]), count(*) into v_ids, v_count
    from jsonb_to_recordset(p_items) as i(id text);
  if exists (select 1 from unnest(v_ids) as x(id) where x.id is null or x.id = '')
     or (select count(distinct x.id) from unnest(v_ids) as x(id)) <> v_count then
    raise exception 'INVALID_ARGUMENT' using errcode = 'PT400';  -- missing or duplicate id
  end if;

  insert into public.work_items as w
    (business_id, id, warning, title, why, lever, cash_effect, needed_by, confidence, score,
     evidence_refs, actions, partner_action, inputs_hash)
  select p_business_id, i.id, i.warning, i.title, i.why, i.lever, i.cash_effect, i.needed_by,
         i.confidence, i.score, coalesce(i.evidence_refs, '{}'::text[]),
         coalesce(i.actions, '[]'::jsonb), i.partner_action, p_inputs_hash
    from jsonb_to_recordset(p_items) as i(
      id text, warning text, title text, why text, lever jsonb, cash_effect bigint, needed_by date,
      confidence double precision, score double precision, evidence_refs text[], actions jsonb,
      partner_action jsonb)
  on conflict (business_id, id) do update set
    warning = excluded.warning, title = excluded.title, why = excluded.why, lever = excluded.lever,
    cash_effect = excluded.cash_effect, needed_by = excluded.needed_by,
    confidence = excluded.confidence, score = excluded.score,
    evidence_refs = excluded.evidence_refs, actions = excluded.actions,
    partner_action = excluded.partner_action, inputs_hash = excluded.inputs_hash;

  delete from public.work_items
   where business_id = p_business_id and state = 'open' and id <> all (v_ids);

  update public.work_items set inputs_hash = p_inputs_hash
   where business_id = p_business_id and inputs_hash is distinct from p_inputs_hash;

  update public.businesses set work_items_inputs_hash = p_inputs_hash where id = p_business_id;
  return v_count;
end
$$;

revoke all on function public.save_work_items(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.save_work_items(text, jsonb, text) to service_role;
