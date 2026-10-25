-- Bank account of a stored actual (CashEvent.account); matches balance_snapshots.account.
-- Used to roll opening cash forward per account. Null for actuals not tagged to an account.
alter table cash_events add column if not exists account text;
