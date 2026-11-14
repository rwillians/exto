create table users (
  id bigint primary key,
  name text not null,
  email varchar(255) not null unique,
  bio text,
  age integer,
  active boolean not null default true,
  score numeric(10, 2),
  data jsonb,
  tags text[] not null default '{}',
  external_id uuid,
  created_at timestamptz not null default now()
);
