import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const email = process.env.ADMIN_E2E_EMAIL;
const password = process.env.ADMIN_E2E_PASSWORD;
const mutationEmail = process.env.ADMIN_E2E_MUTATION_EMAIL;
const mutationPassword = process.env.ADMIN_E2E_MUTATION_PASSWORD;
type RoleCredential = {
  email: string;
  password: string;
  role: 'support' | 'operator' | 'admin' | 'superadmin';
  project?: string;
};
const roleCredentials: RoleCredential[] = JSON.parse(process.env.ADMIN_E2E_ROLE_CREDENTIALS ?? '[]');

function credentialFor(
  role: RoleCredential['role'],
  browserName: string,
): RoleCredential | undefined {
  return roleCredentials.find(
    (candidate) => candidate.role === role && candidate.project === browserName,
  ) ?? roleCredentials.find(
    (candidate) => candidate.role === role && candidate.project === undefined,
  );
}

async function login(page: import('@playwright/test').Page, accountEmail: string, accountPassword: string) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Email').fill(accountEmail);
  await page.getByLabel('Password').fill(accountPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(page.locator('.sidebar-user')).toContainText(accountEmail);
}

const supportPaths = ['/', '/tenants', '/deliverability', '/pools', '/support', '/abuse', '/kyc'];
const operatorPaths = [...supportPaths, '/billing', '/payments', '/settings', '/team', '/dlq'];
const adminPaths = [...operatorPaths, '/audit'];

test('real admin login, session restore, and every console route', async ({ page, browserName }) => {
  const account = credentialFor('superadmin', browserName)
    ?? (email && password ? { email, password, role: 'superadmin' as const } : undefined);
  test.skip(!account, 'A superadmin credential is required for this browser project');

  const serverErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 500) {
      serverErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await login(page, account!.email, account!.password);

  // Prove the HttpOnly session survives a browser reload; a bearer token held
  // only in React memory cannot satisfy this.
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  // The initial anonymous session probe is expected to receive 401 before the
  // login form is submitted. Only treat console errors after authenticated
  // session restoration as route failures.
  consoleErrors.length = 0;

  const routes = [
    ['Fleet overview', '/'],
    ['Tenants', '/tenants'],
    ['Deliverability', '/deliverability'],
    ['IP pools', '/pools'],
    ['Support inbox', '/support'],
    ['Abuse queue', '/abuse'],
    ['KYC / verification', '/kyc'],
    ['Audit log', '/audit'],
    ['Billing & metering', '/billing'],
    ['Payment gateways', '/payments'],
    ['Settings', '/settings'],
    ['Admin team', '/team'],
    ['Dead-letter queue', '/dlq'],
  ] as const;

  const primaryNavigation = page.getByRole('navigation', { name: 'Primary' });
  for (const [label, path] of routes) {
    await primaryNavigation.locator(`a[href="${path}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${path === '/' ? '/$' : `${path}$`}`));
    await expect(page.locator('.topbar .crumb')).toContainText(label);
    await expect(page.locator('main.content')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    const accessibility = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(
      accessibility.violations,
      accessibility.violations.map((violation) =>
        `${violation.id}: ${violation.help} (${violation.nodes.length} nodes)`
      ).join('\n'),
    ).toEqual([]);
  }

  expect(serverErrors, serverErrors.join('\n')).toEqual([]);
  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);

  await page.getByRole('button', { name: /Sign out/i }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

for (const role of ['support', 'operator', 'admin', 'superadmin'] as const) {
  test(`real ${role} role navigation and direct-route boundary`, async ({ page, browserName }) => {
    const account = credentialFor(role, browserName);
    test.skip(!account, `A ${role} credential is required for this browser project`);
    await login(page, account!.email, account!.password);
    const expected = role === 'support'
      ? supportPaths
      : role === 'operator'
        ? operatorPaths
        : adminPaths;
    const actual = await page
      .getByRole('navigation', { name: 'Primary' })
      .locator('a')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href')).filter(Boolean));
    expect(actual.sort()).toEqual([...expected].sort());

    if (role === 'support') {
      await page.goto('/billing');
      await expect(page.getByText('Insufficient role')).toBeVisible();
      await expect(page.getByText(/requires the operator role/i)).toBeVisible();
    } else if (role === 'operator') {
      await page.goto('/audit');
      await expect(page.getByText('Insufficient role')).toBeVisible();
      await expect(page.getByText(/requires the admin role/i)).toBeVisible();
    }

    await page.getByRole('button', { name: /Sign out/i }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });
}

test('real superadmin creates, changes, and disables an admin account', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'State-changing mutation is proven once in Chromium');
  const account = credentialFor('superadmin', browserName)
    ?? (email && password ? { email, password, role: 'superadmin' as const } : undefined);
  test.skip(
    !account || !mutationEmail || !mutationPassword,
    'Superadmin and mutation fixture credentials are required',
  );
  await login(page, account!.email, account!.password);
  await page.getByRole('navigation', { name: 'Primary' }).locator('a[href="/team"]').click();
  await page.getByRole('button', { name: 'Invite admin' }).click();

  let dialog = page.getByRole('dialog', { name: 'Invite admin' });
  await dialog.locator('input[type="email"]').fill(mutationEmail!);
  await dialog.locator('input:not([type]), input[type="text"]').first().fill('Browser Mutation Gate');
  await dialog.locator('select').selectOption('support');
  await dialog.locator('input[type="password"]').fill(mutationPassword!);
  await dialog.getByRole('button', { name: 'Create admin' }).click();
  await expect(page.locator('.toast-wrap')).toContainText(`Admin ${mutationEmail} created`);

  let row = page.locator('tbody tr').filter({ hasText: mutationEmail! });
  await expect(row).toContainText('support');
  await row.getByRole('button', { name: 'Edit' }).click();
  dialog = page.getByRole('dialog', { name: `Edit ${mutationEmail}` });
  await dialog.locator('select').selectOption('operator');
  await dialog.getByRole('switch').click();
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('.toast-wrap')).toContainText('Admin updated');

  row = page.locator('tbody tr').filter({ hasText: mutationEmail! });
  await expect(row).toContainText('operator');
  await expect(row).toContainText(/disabled/i);

  await page.getByRole('button', { name: /Sign out/i }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});
