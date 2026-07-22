import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Mail Platform',
  tagline: 'Self-hosted transactional email infrastructure for developers',
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
      title: 'Mail Platform',
      logo: {
        alt: 'Mail Platform',
        src: 'img/logo.svg',
        srcDark: 'img/logo-dark.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          to: '/docs/api-reference',
          label: 'API Reference',
          position: 'left',
        },
        {
          to: '/docs/SDK',
          label: 'SDK',
          position: 'left',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Getting Started',
          items: [
            { label: 'Quickstart', to: '/docs/guides/getting-started' },
            { label: 'Authentication', to: '/docs/guides/authentication' },
            { label: 'Sending Email', to: '/docs/guides/sending-email' },
            { label: 'Webhooks', to: '/docs/guides/webhooks' },
          ],
        },
        {
          title: 'Guides',
          items: [
            { label: 'Workflows', to: '/docs/guides/workflows' },
            { label: 'Templates', to: '/docs/guides/templates' },
            { label: 'Batch Sending', to: '/docs/guides/batch-sending' },
            { label: 'Suppressions', to: '/docs/guides/suppressions' },
            { label: 'Deliverability', to: '/docs/guides/deliverability' },
            { label: 'Privacy & GDPR', to: '/docs/guides/privacy-gdpr' },
          ],
        },
        {
          title: 'Reference',
          items: [
            { label: 'API Reference', to: '/docs/api-reference' },
            { label: 'Node.js SDK', to: '/docs/SDK' },
            { label: 'Error Codes', to: '/docs/guides/errors' },
            { label: 'Rate Limits', to: '/docs/guides/rate-limits' },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Mail Platform.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
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
