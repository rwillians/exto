create table tags (name text not null, kind text not null);
alter table tags add primary key (name);
alter table tags add constraint tags_kind_name_key unique (kind, name);
alter table tags drop constraint tags_kind_name_key;
alter table tags rename column name to label;
