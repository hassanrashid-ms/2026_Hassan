import { Link } from 'react-router-dom';
import { Button } from '../components/ui/button.tsx';

export function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <h1 className="text-2xl font-semibold text-text">Page not found</h1>
      <p className="max-w-sm text-sm text-muted">
        The page you're looking for doesn't exist or may have moved.
      </p>
      <Button asChild>
        <Link to="/inbox">Back to Inbox</Link>
      </Button>
    </div>
  );
}
