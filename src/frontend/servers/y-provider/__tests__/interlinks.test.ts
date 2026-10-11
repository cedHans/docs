import { ServerBlockNoteEditor } from '@blocknote/server-util';
import request from 'supertest';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';

vi.mock('../src/env', async (importOriginal) => {
  return {
    ...(await importOriginal()),
    COLLABORATION_SERVER_ORIGIN: 'http://localhost:3000',
  };
});

import { docsBlockNoteSchema } from '@/blockSpecs';
import { initApp } from '@/servers';

import { JWKS_URL, COLLABORATION_SERVER_ORIGIN as origin } from '../src/env';

import { mockJwksEndpoint, signAdminToken } from './testUtils/adminJwt';

const apiKey = await signAdminToken();

const DOC_ID = '0b2e8a3c-5d1f-4e6a-9b7c-123456789abc';
const OTHER_ID = '7f3d2c1b-0a9e-4d8c-b7a6-fedcba987654';

const interlink = (docId: string, title: string, blockId = '') => ({
  type: 'interlinkingLinkInline',
  props: {
    docId,
    blockId,
    title,
    disabled: false,
    trigger: '/',
  },
});

const markdownToJson = async (markdown: string) => {
  const response = await request(initApp())
    .post('/api/convert')
    .set('origin', origin)
    .set('authorization', `Bearer ${apiKey}`)
    .set('content-type', 'text/markdown')
    .set('accept', 'application/json')
    .send(markdown);
  expect(response.status).toBe(200);
  return response.body as Array<{
    type: string;
    content: unknown;
    children: Array<{ content: unknown }>;
  }>;
};

// Inline contents of the first block, without the BlockNote defaults noise.
const inlines = (blocks: Array<{ content: unknown }>, index = 0) =>
  blocks[index].content as Array<Record<string, unknown>>;

console.error = vi.fn();

describe('Markdown import turns links to docs into interlinks', () => {
  beforeEach(() => {
    mockJwksEndpoint(JWKS_URL);
  });

  test('absolute link to a doc of the instance', async () => {
    const blocks = await markdownToJson(
      `See [the minutes](http://localhost:3000/docs/${DOC_ID}/) here.`,
    );

    expect(inlines(blocks)).toStrictEqual([
      { type: 'text', text: 'See ', styles: {} },
      interlink(DOC_ID, 'the minutes'),
      { type: 'text', text: ' here.', styles: {} },
    ]);
  });

  test('relative link and link without trailing slash', async () => {
    const blocks = await markdownToJson(
      `[A](/docs/${DOC_ID}/) and [B](http://localhost:3000/docs/${OTHER_ID})`,
    );

    expect(inlines(blocks)).toStrictEqual([
      interlink(DOC_ID, 'A'),
      { type: 'text', text: ' and ', styles: {} },
      interlink(OTHER_ID, 'B'),
    ]);
  });

  test('bare URL is plain text for BlockNote and stays as is', async () => {
    // BlockNote's Markdown parser does not autolink (not even `<url>`), so
    // there is no link to convert: write `[text](url)` to get an interlink.
    const markdown = `See http://localhost:3000/docs/${DOC_ID}/ here`;
    const blocks = await markdownToJson(markdown);

    expect(inlines(blocks)).toStrictEqual([
      { type: 'text', text: markdown, styles: {} },
    ]);
  });

  test('anchor to a block is kept as blockId', async () => {
    const blocks = await markdownToJson(
      `[Section](http://localhost:3000/docs/${DOC_ID}/#initialBlockId)`,
    );

    expect(inlines(blocks)).toStrictEqual([
      interlink(DOC_ID, 'Section', 'initialBlockId'),
    ]);
  });

  test('special characters in the anchor are escaped, round trip is stable', async () => {
    const app = initApp();
    const markdown = `[S](http://localhost:3000/docs/${DOC_ID}/#a%22b%3Cc%20d)`;

    const blocks = await markdownToJson(markdown);
    expect(inlines(blocks)).toStrictEqual([interlink(DOC_ID, 'S', 'a"b<c d')]);

    const yjs = await request(app)
      .post('/api/convert')
      .set('origin', origin)
      .set('authorization', `Bearer ${apiKey}`)
      .set('content-type', 'text/markdown')
      .set('accept', 'application/vnd.yjs.doc')
      .responseType('blob')
      .send(markdown);
    const back = await request(app)
      .post('/api/convert')
      .set('origin', origin)
      .set('authorization', `Bearer ${apiKey}`)
      .set('content-type', 'application/vnd.yjs.doc')
      .set('accept', 'text/html')
      .send(Buffer.from(yjs.body as Buffer));
    expect(back.text).toContain(
      `href="http://localhost:3000/docs/${DOC_ID}/#a%22b%3Cc%20d"`,
    );
  });

  test('a malformed anchor is dropped, the link to the doc is kept', async () => {
    const blocks = await markdownToJson(
      `[S](http://localhost:3000/docs/${DOC_ID}/#bad%E0%A4%A)`,
    );

    expect(inlines(blocks)).toStrictEqual([interlink(DOC_ID, 'S')]);
  });

  test.each([
    ['another origin', `https://example.com/docs/${DOC_ID}/`],
    ['another route', `http://localhost:3000/docs/${DOC_ID}/versions/`],
    ['an invalid doc id', 'http://localhost:3000/docs/not-a-uuid/'],
    ['the docs home', 'http://localhost:3000/docs/'],
    ['a query string', `http://localhost:3000/docs/${DOC_ID}/?x=1`],
    ['a protocol-relative URL', `//example.com/docs/${DOC_ID}/`],
    ['another scheme', `https://localhost:3000/docs/${DOC_ID}/`],
    ['another port', `http://localhost:3001/docs/${DOC_ID}/`],
    ['an URL with credentials', `http://user@localhost:3000/docs/${DOC_ID}/`],
    ['an encoded path', `http://localhost:3000/%64ocs/${DOC_ID}/`],
  ])('link to %s stays a plain link', async (_label, href) => {
    const blocks = await markdownToJson(`[Text](${href})`);

    expect(inlines(blocks)).toStrictEqual([
      {
        type: 'link',
        href,
        content: [{ type: 'text', text: 'Text', styles: {} }],
      },
    ]);
  });

  test('links nested in lists and tables are converted', async () => {
    const blocks = await markdownToJson(
      [
        `- item [A](/docs/${DOC_ID}/)`,
        `  - sub [B](/docs/${OTHER_ID}/)`,
        '',
        '| Doc |',
        '| --- |',
        `| [C](/docs/${DOC_ID}/) |`,
      ].join('\n'),
    );

    expect(inlines(blocks)[1]).toStrictEqual(interlink(DOC_ID, 'A'));
    expect(
      (blocks[0].children[0].content as Array<Record<string, unknown>>)[1],
    ).toStrictEqual(interlink(OTHER_ID, 'B'));

    const table = blocks[1].content as {
      rows: Array<{ cells: Array<{ content: unknown }> }>;
    };
    expect(table.rows[1].cells[0].content).toStrictEqual([
      interlink(DOC_ID, 'C'),
    ]);
  });

  test('a link in a code block is left untouched', async () => {
    const markdown = `\`\`\`\n[A](/docs/${DOC_ID}/)\n\`\`\``;
    const blocks = await markdownToJson(markdown);

    expect(blocks[0].type).toBe('codeBlock');
    expect(inlines(blocks)).toStrictEqual([
      { type: 'text', text: `[A](/docs/${DOC_ID}/)`, styles: {} },
    ]);
  });

  test('Markdown -> Yjs -> Markdown round trip keeps the link to the doc', async () => {
    const app = initApp();
    const markdown = `[Other doc](http://localhost:3000/docs/${DOC_ID}/#initialBlockId)`;

    const yjs = await request(app)
      .post('/api/convert')
      .set('origin', origin)
      .set('authorization', `Bearer ${apiKey}`)
      .set('content-type', 'text/markdown')
      .set('accept', 'application/vnd.yjs.doc')
      .responseType('blob')
      .send(markdown);
    expect(yjs.status).toBe(200);

    // The Yjs document holds a real interlink...
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, new Uint8Array(yjs.body as Buffer));
    const editor = ServerBlockNoteEditor.create({
      schema: docsBlockNoteSchema,
    });
    const stored = editor.yDocToBlocks(ydoc, 'document-store');
    expect(stored[0].content).toStrictEqual([
      {
        ...interlink(DOC_ID, 'Other doc', 'initialBlockId'),
        content: undefined,
      },
    ]);

    // ...exported back as an absolute Markdown link, anchor included.
    const back = await request(app)
      .post('/api/convert')
      .set('origin', origin)
      .set('authorization', `Bearer ${apiKey}`)
      .set('content-type', 'application/vnd.yjs.doc')
      .set('accept', 'text/markdown')
      .send(Buffer.from(yjs.body as Buffer));
    expect(back.status).toBe(200);
    expect(back.text.trim()).toBe(markdown);
  });
});
