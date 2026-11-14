create type status as enum ('queued', 'running', 'done');

create table jobs (
  id bigint primary key,
  status status not null default 'queued',
  previous status
);
