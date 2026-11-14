// The content mapper TypeScript starts for each `.sql` import (package.json,
// `typescript.contentMapper`): JSON-RPC 2.0 over stdio, framed by
// `Content-Length` headers as in LSP.

type Handler = (params: any) => unknown;

const handlers: Record<string, Handler> = {
  initialize: ({ protocolVersion = 1 } = {}) => ({ protocolVersion, positionEncoding: 'utf-8', diagnosticSource: 'exto' }),
  openProject: () => ({ watchedFiles: [], optionDiagnostics: [] }),
  closeProject: () => ({}),
  // the module a `.sql` file becomes: the statement as written, and a
  // parameter for each `:name` in it; the row is hard-coded for now
  transform: ({ content }: { content: string }) => {
    const names = [...new Set(content.match(/(?<!:):[a-z_][a-z0-9_]{0,}/gi) ?? [])].map(name => name.slice(1));
    // the shapes are written out in `run` itself, not behind aliases, so the
    // editor shows them as they are
    const params = `{ ${names.map(name => `${name}: unknown;`).join(' ')} }`;
    const row = `{ id: number; name: string }`;
    const text = [
      `declare const query: {`,
      `  readonly sql: ${JSON.stringify(content)};`,
      `  run(db: unknown, params: ${params}): Promise<${row} | null>;`,
      `};`,
      `export default query;`,
      ``,
    ].join('\n');

    return { extension: '.ts', diagnostics: [], text, mappings: [] };
  },
};

const respond = (message: object) => {
  const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
};

const dispatch = async ({ id, method, params }: { id?: number | string, method: string, params?: unknown }) => {
  try {
    const handler = handlers[method];
    if (!handler) throw new Error(`Unknown method ${method}`);
    const result = await handler(params);
    if (id !== undefined) respond({ id, result: result ?? {} });
  } catch (error) {
    if (id !== undefined) respond({ id, error: { code: -32603, message: String(error) } });
  }
};

let buffer = Buffer.alloc(0);

// TypeScript closes the pipe once it's done with the mapper
process.stdin.on('end', () => process.exit(0));

process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);

  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;

    const length = Number(/Content-Length:\s{0,}(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))?.[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;

    const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
    buffer = buffer.subarray(bodyStart + length);
    void dispatch(JSON.parse(body));
  }
});
