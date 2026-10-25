-- Additive: QuickBooks Online and Xero connectors record their source as evidence channels.
alter table evidence drop constraint if exists evidence_channel_check;
alter table evidence add constraint evidence_channel_check
  check (channel in ('zoho_books', 'quickbooks', 'xero', 'bank_csv', 'email', 'whatsapp', 'crm', 'upload', 'url', 'owner'));

-- One commitment per provider record for the new accounting sources too (same rule as zoho_books).
drop index if exists commitments_source_key;
create unique index commitments_source_key on commitments (business_id, source_system, source_record)
  where source_system in ('zoho_books', 'quickbooks', 'xero', 'bank_csv', 'generic_file');
