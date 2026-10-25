-- Additive: QuickBooks Online and Xero connectors record their source as evidence channels.
alter table evidence drop constraint if exists evidence_channel_check;
alter table evidence add constraint evidence_channel_check
  check (channel in ('zoho_books', 'quickbooks', 'xero', 'bank_csv', 'email', 'whatsapp', 'crm', 'upload', 'url', 'owner'));
