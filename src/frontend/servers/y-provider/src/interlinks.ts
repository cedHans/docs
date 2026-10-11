import { instanceOrigin } from './blockSpecs/InterlinkingLinkInline';

// Same route as the frontend (LinkSelected.tsx, pasteInterlink.ts).
const DOC_PATH_REGEX = /^\/docs\/([^/]+)\/?$/;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Inline = { type: string; [key: string]: unknown };
type Node = { content?: unknown; children?: unknown; [key: string]: unknown };

/**
 * Returns the doc (and anchored block) a link points to when it targets a doc
 * of this instance, either absolute or relative: `/docs/<uuid>/[#<blockId>]`.
 * Returns null for anything else (other origins, credentials, routes, query
 * strings...). The anchor is stored decoded and escaped again on export.
 */
export const parseDocLink = (
  href: string,
): { docId: string; blockId: string } | null => {
  let url: URL;
  try {
    url = new URL(href, instanceOrigin);
  } catch {
    return null;
  }
  if (
    url.origin !== new URL(instanceOrigin).origin ||
    url.username ||
    url.password ||
    url.search
  ) {
    return null;
  }

  const docId = DOC_PATH_REGEX.exec(url.pathname)?.[1];
  if (!docId || !UUID_REGEX.test(docId)) {
    return null;
  }

  let blockId = '';
  try {
    blockId = decodeURIComponent(url.hash.slice(1));
  } catch {
    // Malformed anchor: link to the doc itself.
  }
  return { docId, blockId };
};

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content.map((part: Inline) => (part.text as string) ?? '').join('')
    : '';

const convertInlines = (content: unknown): unknown => {
  if (!Array.isArray(content)) {
    return content;
  }
  return content.map((inline: Inline) => {
    if (inline.type !== 'link' || typeof inline.href !== 'string') {
      return inline;
    }
    const target = parseDocLink(inline.href);
    if (!target) {
      return inline;
    }
    return {
      type: 'interlinkingLinkInline',
      props: {
        docId: target.docId,
        blockId: target.blockId,
        // Only used by exports: the editor displays the doc's current title.
        title: textOf(inline.content),
        disabled: false,
        trigger: '/',
      },
    };
  });
};

const convertContent = (content: unknown): unknown => {
  const table = content as {
    type?: string;
    rows?: Array<{ cells: unknown[] }>;
  };
  if (table?.type === 'tableContent' && Array.isArray(table.rows)) {
    return {
      ...table,
      rows: table.rows.map((row) => ({
        ...row,
        cells: row.cells.map((cell) =>
          Array.isArray(cell)
            ? convertInlines(cell)
            : {
                ...(cell as Node),
                content: convertInlines((cell as Node).content),
              },
        ),
      })),
    };
  }
  return convertInlines(content);
};

/**
 * Turns every link to a doc of this instance into an interlink, in all blocks
 * (nested children and table cells included). This is the import counterpart
 * of the export, which writes interlinks as absolute Markdown links. Code
 * blocks hold plain text, not links, and are left untouched.
 *
 * No document is read here: access to the linked doc is checked when the
 * interlink is rendered, as for pasted links.
 */
export const linksToInterlinks = <T>(blocks: T[]): T[] =>
  blocks.map((block) => {
    const node = block as Node;
    return {
      ...node,
      content: convertContent(node.content),
      children: Array.isArray(node.children)
        ? linksToInterlinks(node.children)
        : node.children,
    } as T;
  });
