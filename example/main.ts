import getAuthor from './get_author.sql';

const author = await getAuthor.run(null, { id: 1 });

const id: number | undefined = author?.id;
const sql: 'select u.id, u.name\nfrom users u\nwhere u.id = :id\n' = getAuthor.sql;

// @ts-expect-error the row has no email
author?.email;

// @ts-expect-error `id` is required
await getAuthor.run(null, {});
