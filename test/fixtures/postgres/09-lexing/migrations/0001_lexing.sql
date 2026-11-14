-- a line comment; with a semicolon
/* a block comment; /* nested; */ still a comment */
begin;

create table notes (
  id bigint primary key, -- trailing comment
  body text not null default 'it''s; fine',
  title text default $$a $tag$ ; b$$,
  footer text default $body$x; y$body$,
  e text default E'line\nbreak; \' quote'
); create table more (id bigint)

;;
insert into notes (id, body) values (1, 'seed; data');
update notes set body = 'changed' where id = 1;
delete from notes where id = 2;

commit;
