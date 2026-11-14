create table tokens (
  value text constraint tokens_pkey primary key,
  owner bigint not null constraint tokens_owner_key unique
);

create table memberships (
  org_id bigint not null,
  user_id bigint not null,
  role text null,
  slug text check (slug <> ''),
  invited_by bigint references tokens (owner) deferrable,
  primary key (org_id, user_id),
  constraint memberships_slug_key unique (org_id, slug),
  constraint role_is_known check (role in ('owner', 'member'))
);
