-- Which forecast run a saved ranking came from (ForecastRun.inputsHash). The API compares it with
-- the current run so the chart and "three things" never mix revisions (TECHNICAL_PLAN sections 4, 8).
-- Nullable: rows saved before this column existed simply read as stale.
alter table work_items add column if not exists inputs_hash text;
