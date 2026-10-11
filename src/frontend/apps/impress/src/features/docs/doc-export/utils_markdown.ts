import JSZip from 'jszip';

import { isSafeUrl } from '@/utils/url';

import { exportResolveFileUrl } from './api';
import { deriveMediaFilename } from './utils_html';

type MediaResolver = (url: string) => Promise<Blob | string>;

interface MediaReference {
  props: Record<string, unknown>;
  src: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Collects media URL properties from a nested editor block tree. */
const collectMediaReferences = (
  blocks: unknown[],
  references: MediaReference[],
) => {
  blocks.forEach((block) => {
    if (!isRecord(block)) {
      return;
    }

    const props = block.props;
    if (isRecord(props) && typeof props.url === 'string' && props.url) {
      references.push({ props, src: props.url });
    }

    if (Array.isArray(block.children)) {
      collectMediaReferences(block.children, references);
    }
  });
};

/**
 * Adds resolvable same-origin media to a Markdown archive and rewrites the
 * corresponding block URLs to archive-local filenames.
 */
export const addMediaFilesToMarkdownZip = async (
  blocks: unknown[],
  zip: JSZip,
  mediaUrl: string,
  resolveMedia: MediaResolver = exportResolveFileUrl,
): Promise<number> => {
  const references: MediaReference[] = [];
  collectMediaReferences(blocks, references);

  let mediaOrigin: string;
  try {
    mediaOrigin = new URL(mediaUrl).origin;
  } catch {
    return 0;
  }

  const mediaFiles = await Promise.all(
    references.map(async ({ props, src }, index) => {
      if (src.startsWith('data:')) {
        return null;
      }

      let url: URL;
      try {
        url = new URL(src, mediaUrl);
      } catch {
        return null;
      }

      if (url.origin !== mediaOrigin || !isSafeUrl(url.href)) {
        return null;
      }

      const blob = await resolveMedia(url.href);
      if (!(blob instanceof Blob)) {
        return null;
      }

      const filename = deriveMediaFilename({
        src: url.href,
        index,
        blob,
      });

      props.url = filename;
      return { filename, blob };
    }),
  );

  let mediaFileCount = 0;
  mediaFiles.forEach((mediaFile) => {
    if (mediaFile) {
      zip.file(mediaFile.filename, mediaFile.blob);
      mediaFileCount += 1;
    }
  });

  return mediaFileCount;
};

const interlinkToLink = (
  inline: Record<string, unknown>,
  titles: Map<string, string>,
  origin: string,
) => {
  const props = isRecord(inline.props) ? inline.props : {};
  const docId = typeof props.docId === 'string' ? props.docId : '';
  // Same as the editor: a disabled or unresolved interlink shows nothing.
  if (props.disabled === true || !docId) {
    return null;
  }

  const blockId = typeof props.blockId === 'string' ? props.blockId : '';
  const href = `${origin}/docs/${encodeURIComponent(docId)}/${
    blockId ? `#${encodeURIComponent(blockId)}` : ''
  }`;

  return {
    type: 'link',
    href,
    content: [{ type: 'text', text: titles.get(docId) || href, styles: {} }],
  };
};

const convertInlineContent = (
  content: unknown[],
  titles: Map<string, string>,
  origin: string,
) =>
  content.flatMap((inline) => {
    if (!isRecord(inline) || inline.type !== 'interlinkingLinkInline') {
      return [inline];
    }
    const link = interlinkToLink(inline, titles, origin);
    return link ? [link] : [];
  });

/**
 * Rewrites, in place, every interlink of a block tree (nested blocks and
 * table cells included) as an absolute link titled after the linked doc.
 * BlockNote's Markdown serializer only keeps the text of custom inline
 * content, so interlinks would otherwise be exported as plain text. This
 * matches the server-side export, and the Markdown import turns these links
 * back into interlinks.
 */
export const interlinksToMarkdownLinks = (
  blocks: unknown[],
  titles: Map<string, string>,
  origin: string,
) => {
  blocks.forEach((block) => {
    if (!isRecord(block)) {
      return;
    }

    const content = block.content;
    if (Array.isArray(content)) {
      block.content = convertInlineContent(content, titles, origin);
    } else if (isRecord(content) && Array.isArray(content.rows)) {
      content.rows.forEach((row) => {
        if (!isRecord(row) || !Array.isArray(row.cells)) {
          return;
        }
        row.cells = row.cells.map((cell) => {
          if (Array.isArray(cell)) {
            return convertInlineContent(cell, titles, origin);
          }
          if (isRecord(cell) && Array.isArray(cell.content)) {
            return {
              ...cell,
              content: convertInlineContent(cell.content, titles, origin),
            };
          }
          return cell;
        });
      });
    }

    if (Array.isArray(block.children)) {
      interlinksToMarkdownLinks(block.children, titles, origin);
    }
  });
};
