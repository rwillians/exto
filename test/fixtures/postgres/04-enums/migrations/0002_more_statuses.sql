alter type status add value 'failed';
alter type status add value 'scheduled' before 'queued';
alter type status add value if not exists 'running';
alter type status rename value 'done' to 'succeeded';

create type "Mood" as enum ();
