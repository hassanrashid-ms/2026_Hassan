import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Closing a route-driven overlay (the article sheet) should be the inverse of
 * however the player arrived, so that closing it from search returns to their
 * results and not to home.
 *
 * navigate(-1) does that — except on a cold deep link, where the game opened the
 * webview directly at /embed/support/articles/:id and there is no previous entry
 * to go back to. React Router marks that first entry with key 'default'; there,
 * fall forward to home instead of stepping out of the app entirely.
 */
export function useCloseOverlay(fallback: string): () => void {
  const navigate = useNavigate();
  const location = useLocation();

  return useCallback(() => {
    if (location.key === 'default') {
      navigate(fallback, { replace: true });
    } else {
      navigate(-1);
    }
  }, [navigate, location.key, fallback]);
}
