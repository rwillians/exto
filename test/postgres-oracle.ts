// Checks each fixture's `catalog.json` against Postgres itself: applies the
// fixture's migrations to a fresh database, reads the catalog back from
// `pg_catalog`, and compares. `--bless` writes what Postgres answers instead.
//
//   docker run -d --rm --name exto-pg-test -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:17
//   node test/postgres-oracle.ts [--bless] [fixture...]
//
// `EXTO_PSQL` is the psql command, `docker exec -i exto-pg-test psql -U postgres` by default.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'postgres');
const DATABASE = 'exto_oracle';

const [command, ...baseArgs] = (process.env['EXTO_PSQL'] ?? 'docker exec -i exto-pg-test psql -U postgres').split(' ');

const psql = (database: string, input: string) => execFileSync(command!, [...baseArgs, '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', database], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

const CATALOG = `
select json_build_object(
  'enums', coalesce((
    select json_object_agg(t.typname, (
      select coalesce(json_agg(e.enumlabel order by e.enumsortorder), '[]'::json) from pg_enum e where e.enumtypid = t.oid
    ) order by t.oid)
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typtype = 'e'
  ), '{}'::json),
  'tables', coalesce((
    select json_object_agg(c.relname, json_build_object(
      'columns', (
        select json_object_agg(a.attname, json_strip_nulls(json_build_object(
          'type', format_type(a.atttypid, a.atttypmod),
          'nullable', not a.attnotnull,
          'default', case when a.atthasdef and a.attgenerated = '' then true end,
          'identity', case a.attidentity when 'a' then 'always' when 'd' then 'by default' end,
          'generated', case when a.attgenerated = 's' then true end
        )) order by a.attnum)
        from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      ),
      'primaryKey', coalesce((
        select json_agg(a.attname order by k.ord)
        from pg_index i
        cross join unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
        where i.indrelid = c.oid and i.indisprimary
      ), '[]'::json),
      'unique', coalesce((
        select json_agg((
          select json_agg(a.attname order by k.ord)
          from unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
          join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
        ) order by i.indexrelid)
        from pg_index i
        where i.indrelid = c.oid and i.indisunique and not i.indisprimary and i.indpred is null and i.indexprs is null
      ), '[]'::json)
    ) order by c.oid)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  ), '{}'::json)
);
`;

const bless = process.argv.includes('--bless');
const only = process.argv.slice(2).filter(arg => !arg.startsWith('--'));

// error fixtures are migrations exto must refuse, which Postgres may accept
const fixtures = readdirSync(FIXTURES)
  .filter(name => !name.startsWith('error-'))
  .filter(name => only.length === 0 || only.includes(name))
  .sort();

let failed = 0;

for (const fixture of fixtures) {
  const dir = join(FIXTURES, fixture, 'migrations');
  const migrations = readdirSync(dir).filter(file => file.endsWith('.sql')).sort();

  psql('postgres', `drop database if exists ${DATABASE}; create database ${DATABASE};`);
  for (const file of migrations) psql(DATABASE, readFileSync(join(dir, file), 'utf8'));

  const actual = JSON.stringify(JSON.parse(psql(DATABASE, CATALOG)), null, 2) + '\n';
  const path = join(FIXTURES, fixture, 'catalog.json');

  if (bless) {
    writeFileSync(path, actual);
    console.log(`blessed ${fixture}`);
  } else if (!existsSync(path) || readFileSync(path, 'utf8') !== actual) {
    failed++;
    console.log(`FAIL ${fixture}\n${actual}`);
  } else {
    console.log(`ok ${fixture}`);
  }
}

psql('postgres', `drop database if exists ${DATABASE};`);
process.exit(failed > 0 ? 1 : 0);
