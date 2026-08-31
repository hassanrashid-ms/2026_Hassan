// Import-boundary enforcement only. No general style/quality ruleset, no
// eslint:recommended, no react/hooks/a11y plugins — see task-2 brief.
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  {
    files: ['**/src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'agent-console', pattern: '**/src/surfaces/agent-console/**/*' },
        { type: 'webview', pattern: '**/src/surfaces/webview/**/*' },
        { type: 'shared', pattern: '**/src/**/*' },
      ],
      'boundaries/ignore': ['**/src/routes/AppRoutes.tsx', '**/src/routes/Login.tsx', '**/src/routes/Login.test.tsx'],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          // Allow everything (including external packages like react,
          // @support/types) by default; only the three cross-zone arrows
          // below are forbidden.
          default: 'allow',
          policies: [
            {
              from: { element: { type: 'agent-console' } },
              disallow: { to: { element: { type: 'webview' } } },
              message: 'agent-console must not import from webview.',
            },
            {
              from: { element: { type: 'webview' } },
              disallow: { to: { element: { type: 'agent-console' } } },
              message: 'webview must not import from agent-console.',
            },
            {
              from: { element: { type: 'shared' } },
              disallow: {
                to: {
                  element: { types: { anyOf: ['agent-console', 'webview'] } },
                },
              },
              message:
                'shared must not import from either surface zone; the dependency arrow is one-directional (surfaces depend on shared, never the reverse).',
            },
          ],
        },
      ],
    },
  },

  // ── The `@/` alias must not become a hole in the boundary above ──
  //
  // `boundaries/dependencies` classifies an import by resolving it to a file on
  // disk. It sees relative paths; it does not see `@/surfaces/agent-console/...`
  // unless a matching import resolver is installed and configured. Introducing
  // the alias for shadcn without this block would leave every cross-surface
  // arrow above trivially bypassable by spelling the import with `@/`.
  //
  // Expressed as path patterns rather than a resolver so it holds with no extra
  // dependency and no resolver configuration to drift out of sync.
  {
    files: ['**/src/surfaces/agent-console/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/surfaces/webview', '@/surfaces/webview/*', '@/webview.css'],
              message: 'agent-console must not import from webview (aliased path).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/src/surfaces/webview/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/surfaces/agent-console', '@/surfaces/agent-console/*'],
              message: 'webview must not import from agent-console (aliased path).',
            },
          ],
        },
      ],
    },
  },
  {
    // Shared code — everything outside the two surface zones. AppRoutes.tsx
    // and routes/Login.tsx are the deliberate crossings and are exempt here
    // for the same reason they are listed in `boundaries/ignore` above: they
    // are the composition-root files — AppRoutes.tsx mounts both consoles'
    // shells, Login.tsx is the single picker that decides which one a signed
    // in agent lands in.
    files: ['**/src/**/*.{ts,tsx}'],
    ignores: ['**/src/surfaces/**', '**/src/routes/AppRoutes.tsx', '**/src/routes/Login.tsx', '**/src/routes/Login.test.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/surfaces/*', '@/surfaces/**'],
              message:
                'shared must not import from either surface zone; the dependency arrow is one-directional (surfaces depend on shared, never the reverse).',
            },
          ],
        },
      ],
    },
  },
);
