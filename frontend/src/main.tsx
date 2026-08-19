import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { Toaster, toast } from 'sonner'
import { AppRoutes } from './routes/AppRoutes.tsx'
import { ApiError } from './lib/httpClient.ts'
import { handleSessionExpired } from './surfaces/agent-console/lib/authErrorHandling.ts'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

// One choke point for every query/mutation failure across the console: an
// expired or revoked session (401/403) redirects to login instead of leaving
// the agent staring at a screen that silently stopped updating, and every
// other failure — network drop, 5xx — surfaces as a toast instead of failing
// invisibly behind whatever inline "could not load" state the component has.
function handleQueryError(error: unknown) {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    handleSessionExpired()
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
