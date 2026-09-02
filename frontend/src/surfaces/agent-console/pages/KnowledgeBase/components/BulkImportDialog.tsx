import { useRef, useState } from 'react';
import { CheckCircle2, FileArchive, Loader2, XCircle } from 'lucide-react';
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
import { cn } from '../../../lib/cn.ts';

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
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setStage('idle');
    setProgress(0);
    setErrorMessage(null);
    setResults(null);
    setDragOver(false);
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
            <input
              ref={inputRef}
              type="file"
              accept=".zip"
              aria-label="Choose a zip file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void handleFile(file);
              }}
            />
            <div
              role="button"
              tabIndex={0}
              aria-label="Drag and drop a zip file, or click to browse"
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const file = e.dataTransfer.files[0];
                if (file) void handleFile(file);
              }}
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed p-8 text-center outline-none',
                dragOver ? 'border-accent bg-accent-soft' : 'border-slate-200',
              )}
            >
              <FileArchive className="size-6 text-muted" />
              <p className="text-sm text-muted">
                Drag &amp; drop a .zip of markdown files, or click to browse
              </p>
              <p className="text-xs text-muted">Max size 20 MB · .md / .markdown files only</p>
            </div>
            {errorMessage && <p className="text-sm text-red-600">{errorMessage}</p>}
          </div>
        )}

        {stage === 'uploading' && (
          <div className="flex flex-col items-center gap-3 py-6">
            <Loader2 className="size-6 animate-spin text-accent" />
            <p className="text-sm text-muted">Uploading… {progress}%</p>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-accent-soft">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-150 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        {stage === 'importing' && (
          <div className="flex flex-col items-center gap-3 py-6">
            <Loader2 className="size-6 animate-spin text-accent" />
            <p className="text-sm text-muted">Importing articles…</p>
          </div>
        )}

        {stage === 'done' && results && (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">
              {results.summary.created} of {results.summary.total} imported
              {results.summary.failed > 0 && (
                <span className="text-muted"> · {results.summary.failed} failed</span>
              )}
            </p>
            <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto text-sm">
              {results.results.map((r) => (
                <li
                  key={r.filename}
                  className="flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2"
                >
                  {r.status === 'created' ? (
                    <CheckCircle2 className="size-4 shrink-0 text-green-600" />
                  ) : (
                    <XCircle className="size-4 shrink-0 text-red-600" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{r.filename}</span>
                  {r.status === 'created' ? (
                    <span className="max-w-[45%] truncate text-green-700">{r.title}</span>
                  ) : (
                    <span className="max-w-[45%] truncate text-red-600">{r.reason}</span>
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
