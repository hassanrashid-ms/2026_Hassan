// Import-boundary enforcement only. No general style/quality ruleset, no
// eslint:recommended, no react/hooks/a11y plugins — see task-2 brief.
import tseslint from 'typescript-eslint'
import boundaries from 'eslint-plugin-boundaries'

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        // Order matters: elements-single-match (default true) uses the first
        // pattern that matches, so the surface patterns must be listed before
        // the shared catch-all.
        { type: 'agent-console', pattern: 'src/surfaces/agent-console/**/*' },
        { type: 'webview', pattern: 'src/surfaces/webview/**/*' },
        { type: 'shared', pattern: 'src/**/*' },
      ],
      // `routes/AppRoutes.tsx` is the single composition root: it lives in
      // `shared` but must import page components from both surfaces to wire
      // up routing. Exempted from boundary checks rather than modeled as a
      // fourth zone, since it's the one deliberate, intentional crossing.
      'boundaries/ignore': ['src/routes/AppRoutes.tsx'],
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
)
