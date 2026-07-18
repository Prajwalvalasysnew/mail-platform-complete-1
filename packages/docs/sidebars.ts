import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: 'category',
      label: 'Getting Started',
      collapsed: false,
      items: [
        { type: 'doc', id: 'guides/getting-started', label: 'Quickstart' },
        { type: 'doc', id: 'guides/authentication', label: 'Authentication' },
      ],
    },
    {
      type: 'category',
      label: 'Sending',
      collapsed: false,
      items: [
        { type: 'doc', id: 'guides/sending-email', label: 'Sending Email' },
        { type: 'doc', id: 'guides/batch-sending', label: 'Batch Sending' },
        { type: 'doc', id: 'guides/templates', label: 'Templates' },
        { type: 'doc', id: 'guides/tracking', label: 'Open & Click Tracking' },
      ],
    },
    {
      type: 'category',
      label: 'Automation',
      collapsed: false,
      items: [
        { type: 'doc', id: 'guides/workflows', label: 'Workflows' },
      ],
    },
    {
      type: 'category',
      label: 'Delivery & Engagement',
      collapsed: false,
      items: [
        { type: 'doc', id: 'guides/webhooks', label: 'Webhooks' },
        { type: 'doc', id: 'guides/activity-analytics', label: 'Activity & Analytics' },
        { type: 'doc', id: 'guides/suppressions', label: 'Suppressions' },
        { type: 'doc', id: 'guides/unsubscribe-groups', label: 'Unsubscribe Groups' },
      ],
    },
    {
      type: 'category',
      label: 'Deliverability & Compliance',
      collapsed: false,
      items: [
        { type: 'doc', id: 'guides/deliverability', label: 'Deliverability' },
        { type: 'doc', id: 'guides/dns-setup', label: 'Domain Authentication' },
      ],
    },
    {
      type: 'category',
      label: 'Account',
      collapsed: false,
      items: [
        { type: 'doc', id: 'guides/account-quotas', label: 'Quotas & Usage' },
        { type: 'doc', id: 'guides/privacy-gdpr', label: 'Privacy & GDPR' },
        { type: 'doc', id: 'guides/support', label: 'Support' },
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      collapsed: false,
      items: [
        { type: 'doc', id: 'api-reference', label: 'API Reference' },
        { type: 'doc', id: 'SDK', label: 'Node.js SDK' },
        { type: 'doc', id: 'guides/errors', label: 'Errors & Handling' },
        { type: 'doc', id: 'guides/rate-limits', label: 'Rate Limits' },
      ],
    },
  ],
};

export default sidebars;
