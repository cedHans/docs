import { VariantType } from '@gouvfr-lasuite/ui-components';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { type Doc } from '@/docs/doc-management/types';
import { AppWrapper } from '@/tests/utils';

import { ModalExport } from '../components/ModalExport';

const mocks = vi.hoisted(() => ({
  addMediaFilesToMarkdownZip: vi.fn(),
  blocksToMarkdownLossy: vi.fn(),
  document: [] as unknown[],
  interlinksToMarkdownLinks: vi.fn(),
  resolveInterlinkTitles: vi.fn(),
  downloadFile: vi.fn(),
  docToBlob: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@gouvfr-lasuite/ui-components', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@gouvfr-lasuite/ui-components')>();

  return {
    ...actual,
    useToastProvider: () => ({ toast: mocks.toast }),
  };
});

vi.mock('@/core', () => ({
  useMediaUrl: () => 'https://media.test',
}));

vi.mock('@/docs/doc-editor/stores/useEditorStore', () => ({
  useEditorStore: () => ({
    editor: {
      document: mocks.document,
      blocksToMarkdownLossy: mocks.blocksToMarkdownLossy,
    },
  }),
}));

vi.mock('@/docs/doc-management', () => ({
  useTrans: () => ({ untitledDocument: 'Untitled document' }),
}));

vi.mock('../hooks/', () => ({
  default: {
    useExportAGPL: () => ({
      formats: [{ label: 'PDF', value: 'pdf', labelDescription: '.pdf' }],
      docToBlob: mocks.docToBlob,
    }),
  },
}));

vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>();

  return {
    ...actual,
    downloadFile: mocks.downloadFile,
    resolveInterlinkTitles: mocks.resolveInterlinkTitles,
  };
});

vi.mock('../utils_markdown', () => ({
  addMediaFilesToMarkdownZip: mocks.addMediaFilesToMarkdownZip,
  interlinksToMarkdownLinks: mocks.interlinksToMarkdownLinks,
}));

describe('ModalExport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.addMediaFilesToMarkdownZip.mockResolvedValue(0);
    mocks.blocksToMarkdownLossy.mockResolvedValue('# Roadmap');
    mocks.docToBlob.mockResolvedValue(undefined);
    mocks.resolveInterlinkTitles.mockResolvedValue(new Map());
  });

  test('writes interlinks as links in the Markdown export', async () => {
    const titles = new Map([['doc-id', 'Minutes']]);
    mocks.resolveInterlinkTitles.mockResolvedValue(titles);
    mocks.document.splice(0, mocks.document.length, { type: 'paragraph' });
    const user = userEvent.setup();

    render(
      <ModalExport doc={{ title: 'Roadmap' } as Doc} onClose={vi.fn()} />,
      { wrapper: AppWrapper },
    );

    await user.click(screen.getByRole('combobox', { name: 'Format' }));
    await user.click(screen.getByRole('option', { name: /Markdown/ }));
    await user.click(screen.getByTestId('doc-export-download-button'));

    await waitFor(() => expect(mocks.downloadFile).toHaveBeenCalled());
    // Applied on a copy of the document, before the Markdown serialization.
    const [blocks, passedTitles, origin] =
      mocks.interlinksToMarkdownLinks.mock.calls[0];
    expect(blocks).toStrictEqual([{ type: 'paragraph' }]);
    expect(blocks).not.toBe(mocks.document);
    expect(passedTitles).toBe(titles);
    expect(origin).toBe(window.location.origin);
    expect(mocks.blocksToMarkdownLossy).toHaveBeenCalledWith(blocks);
    mocks.document.splice(0, mocks.document.length);
  });

  test('downloads Markdown directly when no media is archived', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <ModalExport doc={{ title: 'Roadmap' } as Doc} onClose={onClose} />,
      { wrapper: AppWrapper },
    );

    await user.click(screen.getByRole('combobox', { name: 'Format' }));
    await user.click(screen.getByRole('option', { name: /Markdown/ }));
    await user.click(screen.getByTestId('doc-export-download-button'));

    await waitFor(() =>
      expect(mocks.downloadFile).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'text/markdown;charset=utf-8' }),
        'roadmap.md',
      ),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('downloads a ZIP when Markdown contains archived media', async () => {
    mocks.addMediaFilesToMarkdownZip.mockResolvedValue(1);
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <ModalExport doc={{ title: 'Roadmap' } as Doc} onClose={onClose} />,
      { wrapper: AppWrapper },
    );

    await user.click(screen.getByRole('combobox', { name: 'Format' }));
    await user.click(screen.getByRole('option', { name: /Markdown/ }));
    await user.click(screen.getByTestId('doc-export-download-button'));

    await waitFor(() =>
      expect(mocks.downloadFile).toHaveBeenCalledWith(
        expect.any(Blob),
        'roadmap.zip',
      ),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('clears the loading state when Markdown media export fails', async () => {
    let rejectMediaExport: (reason: Error) => void = () => undefined;
    mocks.addMediaFilesToMarkdownZip.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectMediaExport = reject;
        }),
    );
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <ModalExport doc={{ title: 'Roadmap' } as Doc} onClose={onClose} />,
      { wrapper: AppWrapper },
    );

    await user.click(screen.getByRole('combobox', { name: 'Format' }));
    await user.click(screen.getByRole('option', { name: /Markdown/ }));

    const downloadButton = screen.getByTestId('doc-export-download-button');
    await user.click(downloadButton);
    await waitFor(() => expect(downloadButton).toBeDisabled());

    await act(async () => {
      rejectMediaExport(new Error('Media export failed'));
    });

    await waitFor(() => expect(downloadButton).toBeEnabled());
    expect(mocks.toast).toHaveBeenCalledWith(
      'The export failed',
      VariantType.ERROR,
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
