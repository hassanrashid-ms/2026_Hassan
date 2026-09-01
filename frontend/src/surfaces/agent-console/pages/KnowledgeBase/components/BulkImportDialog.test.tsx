import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BulkImportDialog } from './BulkImportDialog.tsx';
import * as api from '../../../api/agentApi.ts';

vi.mock('../../../api/agentApi.ts');

function makeZipFile(name = 'articles.zip', sizeBytes = 1024): File {
  return new File([new Uint8Array(sizeBytes)], name, { type: 'application/zip' });
}

describe('BulkImportDialog', () => {
  beforeEach(() => {
    vi.mocked(api.requestUpload).mockResolvedValue({
      key: 'pending/w/a/x.zip',
      upload_url: 'https://example.test/upload',
      expires_at: new Date().toISOString(),
    });
    vi.mocked(api.putFileToUploadUrl).mockResolvedValue(undefined);
  });

  it('rejects a file over the 20MB client-side cap without calling the API', async () => {
    const onImported = vi.fn();
    render(
      <BulkImportDialog open token="t" onOpenChange={() => {}} onImported={onImported} />,
    );
    const input = screen.getByLabelText(/choose.*zip/i);
    const tooBig = makeZipFile('big.zip', 21 * 1024 * 1024);
    fireEvent.change(input, { target: { files: [tooBig] } });

    await waitFor(() => expect(screen.getByText(/20MB/i)).toBeInTheDocument());
    expect(api.requestUpload).not.toHaveBeenCalled();
  });

  it('uploads, imports, and shows per-file results on success', async () => {
    vi.mocked(api.bulkImportArticles).mockResolvedValue({
      results: [
        { filename: 'a.md', status: 'created', title: 'Article A', article_id: '1' },
        { filename: 'b.md', status: 'error', reason: 'empty_file' },
      ],
      summary: { total: 2, created: 1, failed: 1 },
    });
    const onImported = vi.fn();
    render(
      <BulkImportDialog open token="t" onOpenChange={() => {}} onImported={onImported} />,
    );
    const input = screen.getByLabelText(/choose.*zip/i);
    fireEvent.change(input, { target: { files: [makeZipFile()] } });

    await waitFor(() => expect(screen.getByText(/1 of 2 imported/i)).toBeInTheDocument());
    expect(screen.getByText('Article A')).toBeInTheDocument();
    expect(screen.getByText(/empty_file/i)).toBeInTheDocument();
    expect(onImported).toHaveBeenCalledWith(
      expect.objectContaining({ summary: { total: 2, created: 1, failed: 1 } }),
    );
  });

  it('shows an error state if the import call rejects', async () => {
    vi.mocked(api.bulkImportArticles).mockRejectedValue(new Error('boom'));
    render(<BulkImportDialog open token="t" onOpenChange={() => {}} onImported={() => {}} />);
    const input = screen.getByLabelText(/choose.*zip/i);
    fireEvent.change(input, { target: { files: [makeZipFile()] } });

    await waitFor(() => expect(screen.getByText(/could not import/i)).toBeInTheDocument());
  });
});
