import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import apiEndpoints from './src/plugins/api-endpoints.mjs';

// Optional link from the docs header back to the product (e.g. https://app.example.com).
const appUrl = process.env.APP_BASE_URL;

const config: Config = {
  title: 'Valasys Docs',
  tagline: 'Guides and API reference for sending, automating and tracking email with Valasys',
  favicon: 'img/favicon.svg',

  // Set to your docs subdomain, e.g. https://docs.yourcompany.com
  url: process.env.DOCS_URL ?? 'https://docs.yourplatform.com',
  baseUrl: '/',

  // Fail the production build on any broken link — a public docs site must
  // never ship 404s. (Was 'warn', which let breakage through silently.)
  onBrokenLinks: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  clientModules: [require.resolve('./src/fonts.ts')],

  themes: [
    [
      '@easyops-cn/docusaurus-search-local',
      {
        // Offline full-text search: the index is built with the site, no external service.
        hashed: true,
        indexBlog: false,
        docsDir: '../../docs',
        docsRouteBasePath: '/docs',
        highlightSearchTermsOnTargetPage: true,
        explicitSearchResultPath: true,
        searchBarShortcutHint: true,
        searchBarPosition: 'right',
      },
    ],
  ],

  plugins: [
    // webpackbar@6.0.1 (used by Docusaurus for build progress) overwrites
    // this.options with {name, color, reporters, reporter} which webpack 5.95+
    // rejects in ProgressPlugin schema validation. Remove it so builds succeed
    // without a progress bar — functionality is unaffected.
    function removeWebpackBarCompat() {
      return {
        name: 'compat-remove-webpackbar',
        configureWebpack(config: { plugins?: { constructor?: { name?: string } }[] }) {
          if (Array.isArray(config.plugins)) {
            config.plugins = config.plugins.filter(
              (p) => p?.constructor?.name !== 'WebpackBarPlugin',
            );
          }
          return {};
        },
      };
    },
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          // Points to the root docs/ directory in the repo
          path: '../../docs',
          sidebarPath: './sidebars.ts',
          routeBasePath: '/docs',
          editUrl: undefined,
          rehypePlugins: [apiEndpoints],
          showLastUpdateTime: false,
          // The repo docs/ directory also holds INTERNAL engineering material
          // (runbooks, audit plans, testing infra notes). Only the curated
          // public set below is built and published — everything else stays
          // out of the site (and out of its search index).
          include: [
            'index.md',
            'api-reference.md',
            'api-versioning.md',
            'SDK.md',
            'COMPLIANCE_POSTURE.md',
            'guides/**/*.{md,mdx}',
          ],
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/og-card.png',
    navbar: {
      title: 'Valasys',
      hideOnScroll: false,
      logo: {
        alt: 'Valasys',
        src: 'img/logo.svg',
        srcDark: 'img/logo-dark.svg',
        width: 28,
        height: 28,
      },
      items: [
        { type: 'html', position: 'left', value: '<span class="navbar-docs-tag">Docs</span>', className: 'navbar-docs-item' },
        { to: '/docs/guides/getting-started', label: 'Guides', position: 'left', activeBaseRegex: '/docs/(guides|COMPLIANCE)' },
        { to: '/docs/api-reference', label: 'API reference', position: 'left', activeBaseRegex: '/docs/api-reference' },
        { to: '/docs/SDK', label: 'SDK', position: 'left' },
        { to: '/docs/guides/support', label: 'Support', position: 'right' },
        ...(appUrl ? [{ href: appUrl, label: 'Open dashboard', position: 'right' as const, className: 'navbar-app-link' }] : []),
      ],
    },
    footer: {
      style: 'light',
      links: [
        {
          title: 'Get started',
          items: [
            { label: 'Quickstart', to: '/docs/guides/getting-started' },
            { label: 'Authentication', to: '/docs/guides/authentication' },
            { label: 'Domain authentication', to: '/docs/guides/dns-setup' },
            { label: 'Migrate from SendGrid', to: '/docs/guides/migrate-from-sendgrid' },
          ],
        },
        {
          title: 'Guides',
          items: [
            { label: 'Sending email', to: '/docs/guides/sending-email' },
            { label: 'Templates', to: '/docs/guides/templates' },
            { label: 'Workflows', to: '/docs/guides/workflows' },
            { label: 'Webhooks', to: '/docs/guides/webhooks' },
            { label: 'Deliverability', to: '/docs/guides/deliverability' },
          ],
        },
        {
          title: 'Reference',
          items: [
            { label: 'API reference', to: '/docs/api-reference' },
            { label: 'Node.js SDK', to: '/docs/SDK' },
            { label: 'Errors', to: '/docs/guides/errors' },
            { label: 'Rate limits', to: '/docs/guides/rate-limits' },
            { label: 'OpenAPI spec', href: 'pathname:///openapi.json' },
          ],
        },
        {
          title: 'Trust',
          items: [
            { label: 'Security & compliance', to: '/docs/guides/security-compliance' },
            { label: 'Privacy & GDPR', to: '/docs/guides/privacy-gdpr' },
            { label: 'Support', to: '/docs/guides/support' },
          ],
        },
      ],
      copyright: `© ${new Date().getFullYear()} Valasys`,
    },
    docs: {
      sidebar: { hideable: true, autoCollapseCategories: false },
    },
    tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
    prism: {
      // Dark code panels in both modes, like the code samples in the app.
      theme: prismThemes.oneDark,
      darkTheme: prismThemes.oneDark,
      additionalLanguages: ['bash', 'json', 'typescript', 'python', 'go', 'ruby', 'php'],
    },
    colorMode: {
      defaultMode: 'light',
      disableSwitch: false,
      respectPrefersColorScheme: true,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
