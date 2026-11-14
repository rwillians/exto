create type kind as enum ('a', 'b');
create table keep (id bigint primary key);
create table gone (id bigint primary key, kind kind);
create table also_gone (id bigint);
create type unused as enum ('x');
