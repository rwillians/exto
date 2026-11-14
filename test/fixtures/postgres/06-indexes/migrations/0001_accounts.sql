create table accounts (
  id bigint primary key,
  email text not null,
  tenant bigint not null,
  handle text,
  deleted_at timestamptz
);

create index accounts_tenant_index on accounts (tenant);
create unique index accounts_tenant_email_index on accounts (tenant, email);
create unique index if not exists accounts_handle_index on accounts using btree (handle);
create unique index accounts_live_email_index on accounts (email) where deleted_at is null;
create unique index accounts_lower_email_index on accounts (lower(email));
create unique index accounts_email_index on accounts (email);
