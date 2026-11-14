create table "UserProfiles" (
  "Id" bigint primary key,
  DisplayName text,
  "order" integer,
  "user" text,
  "with space" text,
  "quote""d" text
);

create table public.qualified (id bigint);
create table if not exists qualified (other text);
alter table public."UserProfiles" add column "Bio" text;
