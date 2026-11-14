create table users (
  id bigint primary key,
  name text,
  email text unique,
  age integer,
  nickname text
);
