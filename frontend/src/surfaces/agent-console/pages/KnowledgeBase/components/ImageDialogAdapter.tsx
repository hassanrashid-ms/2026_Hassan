import { useEffect, useState } from 'react';
import {
  imageDialogState$,
  saveImage$,
  closeImageDialog$,
  useCellValues,
  usePublisher,
} from '@mdxeditor/editor';
import { ImageInsertDialog } from '../../../../../components/ImageInsertDialog.tsx';

// Mirrors backend/src/shared/storage/presign.ts's ALLOWED_IMAGE_MIME_TYPES /
// MAX_ATTACHMENT_BYTES, same duplication rationale as Composer.tsx.
const ALLOWED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// saveImage$ expects SaveImageParameters['file'] to be a FileList (it's normally
// populated by a real <input type="file"> registered via react-hook-form); only
// `.length` and `.item(0)` are ever read from it, so a minimal shim stands in.
function toFileList(file: File): FileList {
  return { length: 1, item: () => file } as unknown as FileList;
}

export function ImageDialogAdapter() {
  const [state] = useCellValues(imageDialogState$);
  const saveImage = usePublisher(saveImage$);
  const closeImageDialog = usePublisher(closeImageDialog$);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (state.type === 'inactive') {
      setUploading(false);
      setError(null);
    }
  }, [state.type]);

  if (state.type === 'inactive') return null;

  const initialValues = state.type === 'editing' ? state.initialValues : undefined;

  return (
    <ImageInsertDialog
      open
      onOpenChange={(open) => {
        if (!open) closeImageDialog();
      }}
      mode={state.type === 'editing' ? 'editing' : 'new'}
      initialAltText={initialValues?.altText}
      initialSrc={initialValues?.src}
      uploading={uploading}
      error={error}
      onUpload={(file, altText) => {
        setError(null);
        if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.type)) {
          setError('Only PNG, JPEG, WebP or GIF images are supported.');
          return;
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
          setError('Images must be 10 MB or smaller.');
          return;
        }
        setUploading(true);
        saveImage({ file: toFileList(file), altText });
      }}
      onLink={(src, altText) => {
        saveImage({ src, altText });
      }}
    />
  );
}
