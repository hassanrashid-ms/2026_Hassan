import { useRef, useState } from 'react';
import type { BulkImportArticlesResponse } from '@support/types';
import { bulkImportArticles, putFileToUploadUrl, requestUpload } from '../../../api/agentApi.ts';
import { Button } from '../../../components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog.tsx';

const MAX_ZIP_BYTES = 20 * 1024 * 1024;

type Stage = 'idle' | 'uploading' | 'importing' | 'done' | 'error';

export function BulkImportDialog({
  open,
  onOpenChange,
  token,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  onImported: (response: BulkImportArticlesResponse) => void;
}) {
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [results, setResults] = useState<BulkImportArticlesResponse | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setStage('idle');
    setProgress(0);
    setErrorMessage(null);
    setResults(null);
  }

  async function handleFile(file: File) {
    setErrorMessage(null);
    setResults(null);
    if (file.size > MAX_ZIP_BYTES) {
      setErrorMessage('That file exceeds the 20MB limit.');
      return;
    }
    try {
      setStage('uploading');
      setProgress(0);
      const uploaded = await requestUpload(token, {
        filename: file.name,
        contentType: 'application/zip',
        byteSize: file.size,
      });
      await putFileToUploadUrl(uploaded.upload_url, file, setProgress, 'application/zip');
      setStage('importing');
      const response = await bulkImportArticles(token, { key: uploaded.key });
      setResults(response);
      setStage('done');
      onImported(response);
    } catch {
      setErrorMessage('Could not import that zip. Please try again.');
      setStage('error');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bulk import from zip</DialogTitle>
        </DialogHeader>

        {(stage === 'idle' || stage === 'error') && (
          <div className="flex flex-col gap-3">
            <label htmlFor="bulk-import-zip-input" className="text-sm text-muted">
              Choose a .zip of markdown files to import
            </label>
            <input
              id="bulk-import-zip-input"
              ref={inputRef}
              type="file"
              accept=".zip"
              aria-label="Choose a zip file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void handleFile(file);
              }}
            />
            {errorMessage && <p className="text-sm text-red-600">{errorMessage}</p>}
          </div>
        )}

        {stage === 'uploading' && (
          <p className="text-sm text-muted">Uploading… {progress}%</p>
        )}

        {stage === 'importing' && <p className="text-sm text-muted">Importing articles…</p>}

        {stage === 'done' && results && (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">
              {results.summary.created} of {results.summary.total} imported
            </p>
            <ul className="max-h-64 overflow-y-auto text-sm">
              {results.results.map((r) => (
                <li key={r.filename} className="flex items-center justify-between gap-2 py-1">
                  <span className="truncate">{r.filename}</span>
                  {r.status === 'created' ? (
                    <span className="text-green-700">{r.title}</span>
                  ) : (
                    <span className="text-red-600">{r.reason}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
