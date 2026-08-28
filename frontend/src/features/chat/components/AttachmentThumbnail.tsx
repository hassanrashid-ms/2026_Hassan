/**
 * The thumbnail cell for a picked/uploading/sent attachment — shared between
 * the agent-console Composer and the webview ChatComposer (see Composer.tsx's
 * own note on why those two don't share a wrapping component: this is a leaf
 * node styled in tokens, not a layout owner). Renders the file's own local
 * blob URL immediately, so the user sees what they picked before the network
 * upload finishes, then dims it under a real-progress ring while `uploading`.
 */
export function AttachmentThumbnail({
  previewUrl,
  mimeType,
  filename,
  uploading,
  progress,
  className = 'h-14 w-14 rounded-md',
}: {
  previewUrl: string;
  mimeType: string;
  filename: string;
  uploading: boolean;
  /** 0-100. Only read while `uploading` is true. */
  progress: number;
  className?: string;
}) {
  const isVideo = mimeType.startsWith('video/');
  const radius = 15;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (Math.min(Math.max(progress, 0), 100) / 100) * circumference;

  return (
    <div className={`relative shrink-0 overflow-hidden ${className}`}>
      {isVideo ? (
        <video
          data-testid="pending-video-preview"
          src={previewUrl}
          muted
          className={`h-full w-full object-cover transition-all duration-300 ${
            uploading ? 'scale-105 opacity-60 blur-[1px]' : 'opacity-100'
          }`}
        />
      ) : (
        <img
          src={previewUrl}
          alt={filename}
          className={`h-full w-full object-cover transition-all duration-300 ${
            uploading ? 'scale-105 opacity-60 blur-[1px]' : 'opacity-100'
          }`}
        />
      )}
      {uploading && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-black/25"
          data-testid="upload-progress-overlay"
        >
          <svg viewBox="0 0 36 36" className="size-7 -rotate-90">
            <circle cx="18" cy="18" r={radius} fill="none" stroke="white" strokeOpacity="0.3" strokeWidth="3" />
            <circle
              cx="18"
              cy="18"
              r={radius}
              fill="none"
              stroke="white"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              className="transition-[stroke-dashoffset] duration-150 ease-out"
            />
          </svg>
        </div>
      )}
    </div>
  );
}
