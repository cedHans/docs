import JSZip from 'jszip';
import { describe, expect, test, vi } from 'vitest';

import {
  addMediaFilesToMarkdownZip,
  interlinksToMarkdownLinks,
} from '../utils_markdown';

describe('addMediaFilesToMarkdownZip', () => {
  test('localizes same-origin media without mutating unrelated URLs', async () => {
    const blocks = [
      {
        type: 'image',
        props: { url: 'https://media.test/media/photo.png' },
      },
      {
        type: 'image',
        props: { url: 'https://external.test/photo.png' },
      },
      {
        type: 'image',
        props: { url: 'data:image/png;base64,aGVsbG8=' },
      },
    ];
    const zip = new JSZip();
    const imageBlob = new Blob(['image'], { type: 'image/png' });
    const resolveMedia = vi.fn().mockResolvedValue(imageBlob);

    const mediaFileCount = await addMediaFilesToMarkdownZip(
      blocks,
      zip,
      'https://media.test',
      resolveMedia,
    );

    expect(mediaFileCount).toBe(1);
    expect(resolveMedia).toHaveBeenCalledOnce();
    expect(resolveMedia).toHaveBeenCalledWith(
      'https://media.test/media/photo.png',
    );
    expect(blocks[0].props.url).toBe('1-photo.png');
    expect(blocks[1].props.url).toBe('https://external.test/photo.png');
    expect(blocks[2].props.url).toBe('data:image/png;base64,aGVsbG8=');
    expect(zip.file('1-photo.png')).not.toBeNull();
  });

  test('finds nested media and keeps its URL when fetching fails', async () => {
    const blocks = [
      {
        type: 'columnList',
        children: [
          {
            type: 'image',
            props: { url: '/media/nested.svg' },
          },
        ],
      },
    ];
    const zip = new JSZip();
    const resolveMedia = vi.fn().mockResolvedValue('/media/nested.svg');

    const mediaFileCount = await addMediaFilesToMarkdownZip(
      blocks,
      zip,
      'https://media.test',
      resolveMedia,
    );

    expect(mediaFileCount).toBe(0);
    expect(resolveMedia).toHaveBeenCalledWith(
      'https://media.test/media/nested.svg',
    );
    expect(blocks[0].children[0].props.url).toBe('/media/nested.svg');
    expect(Object.keys(zip.files)).toHaveLength(0);
  });
});

describe('interlinksToMarkdownLinks', () => {
  const DOC_A = '0b2e8a3c-5d1f-4e6a-9b7c-123456789abc';
  const DOC_B = '7f3d2c1b-0a9e-4d8c-b7a6-fedcba987654';
  const interlink = (docId: string, blockId = '') => ({
    type: 'interlinkingLinkInline',
    props: { docId, blockId, disabled: false, trigger: '/' },
  });
  const titles = new Map([
    [DOC_A, 'Minutes'],
    [DOC_B, 'Roadmap'],
  ]);

  test('turns interlinks into absolute links titled after the doc', () => {
    const blocks = [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'See ', styles: {} },
          interlink(DOC_A),
          { type: 'text', text: ' and ', styles: {} },
          interlink(DOC_B, 'block-1'),
        ],
        children: [],
      },
    ];

    interlinksToMarkdownLinks(blocks, titles, 'https://docs.test');

    expect(blocks[0].content).toStrictEqual([
      { type: 'text', text: 'See ', styles: {} },
      {
        type: 'link',
        href: `https://docs.test/docs/${DOC_A}/`,
        content: [{ type: 'text', text: 'Minutes', styles: {} }],
      },
      { type: 'text', text: ' and ', styles: {} },
      {
        type: 'link',
        href: `https://docs.test/docs/${DOC_B}/#block-1`,
        content: [{ type: 'text', text: 'Roadmap', styles: {} }],
      },
    ]);
  });

  test('converts interlinks in nested blocks and table cells', () => {
    const blocks = [
      {
        type: 'bulletListItem',
        content: [],
        children: [
          { type: 'paragraph', content: [interlink(DOC_A)], children: [] },
        ],
      },
      {
        type: 'table',
        content: {
          type: 'tableContent',
          rows: [
            {
              cells: [
                { type: 'tableCell', content: [interlink(DOC_B)], props: {} },
              ],
            },
          ],
        },
        children: [],
      },
    ];

    interlinksToMarkdownLinks(blocks, titles, 'https://docs.test');

    expect(blocks[0].children[0].content).toStrictEqual([
      {
        type: 'link',
        href: `https://docs.test/docs/${DOC_A}/`,
        content: [{ type: 'text', text: 'Minutes', styles: {} }],
      },
    ]);
    const table = blocks[1].content as {
      rows: { cells: { content: unknown }[] }[];
    };
    expect(table.rows[0].cells[0].content).toStrictEqual([
      {
        type: 'link',
        href: `https://docs.test/docs/${DOC_B}/`,
        content: [{ type: 'text', text: 'Roadmap', styles: {} }],
      },
    ]);
  });

  test('falls back to the URL as text when the title is unknown', () => {
    const blocks = [
      { type: 'paragraph', content: [interlink(DOC_A)], children: [] },
    ];

    interlinksToMarkdownLinks(blocks, new Map(), 'https://docs.test');

    expect(blocks[0].content).toStrictEqual([
      {
        type: 'link',
        href: `https://docs.test/docs/${DOC_A}/`,
        content: [
          {
            type: 'text',
            text: `https://docs.test/docs/${DOC_A}/`,
            styles: {},
          },
        ],
      },
    ]);
  });

  test('drops disabled and unresolved interlinks', () => {
    const blocks = [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'a', styles: {} },
          { ...interlink(DOC_A), props: { docId: DOC_A, disabled: true } },
          interlink(''),
          { type: 'text', text: 'b', styles: {} },
        ],
        children: [],
      },
    ];

    interlinksToMarkdownLinks(blocks, titles, 'https://docs.test');

    expect(blocks[0].content).toStrictEqual([
      { type: 'text', text: 'a', styles: {} },
      { type: 'text', text: 'b', styles: {} },
    ]);
  });

  test('escapes the anchor', () => {
    const blocks = [
      {
        type: 'paragraph',
        content: [interlink(DOC_A, 'a b"c')],
        children: [],
      },
    ];

    interlinksToMarkdownLinks(blocks, titles, 'https://docs.test');

    expect(blocks[0].content[0]).toMatchObject({
      href: `https://docs.test/docs/${DOC_A}/#a%20b%22c`,
    });
  });
});
