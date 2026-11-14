alter table users rename to people;
alter table people add column handle text, add column score integer not null default 0;
alter table people add constraint people_handle_key unique (handle);
alter table people alter column bio set default 'n/a', alter column full_name drop not null;
alter table if exists missing add column x int;
