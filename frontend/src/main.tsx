import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { Toaster, toast } from 'sonner'
import { AppRoutes } from './routes/AppRoutes.tsx'
import { ApiError } from './lib/httpClient.ts'
import { handleSessionExpired } from './surfaces/agent-console/lib/authErrorHandling.ts'
import { handleAdminSessionExpired } from './surfaces/admin-console/lib/adminAuthErrorHandling.ts'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

// One choke point for every query/mutation failure across the console: an
// expired or revoked session (401) redirects to login instead of leaving the
// agent staring at a screen that silently stopped updating. A 403 is a real
// session lacking permission for this action — never a logout, per CLAUDE.md's
// "permission checks run at the API" rule — so it surfaces as a toast like any
// other failure (network drop, 5xx) instead of failing invisibly behind
// whatever inline "could not load" state the component has.
//
// Dispatched by URL prefix rather than by which surface raised the error:
// this handler is a single global choke point shared by every surface's
// QueryClient, so it has no other reliable way to know which session to drop.
function handleQueryError(error: unknown) {
  if (error instanceof ApiError && error.status === 401) {
    if (window.location.pathname.startsWith('/dashboard')) {
      handleAdminSessionExpired()
    } else {
      handleSessionExpired()
    }
    return
  }
  toast.error(error instanceof ApiError ? error.message : 'Something went wrong. Please try again.')
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleQueryError }),
  mutationCache: new MutationCache({ onError: handleQueryError }),
})

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
      <Toaster richColors position="top-right" />
    </QueryClientProvider>
  </StrictMode>,
)
