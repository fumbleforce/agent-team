import { expect, test, type Page } from '@playwright/test';

const PROJECT = '/p/checkout-v2';
const SCREENS: [string, string][] = [
  ['task board', `${PROJECT}/tasks`], ['issues', `${PROJECT}/issues`], ['product view', `${PROJECT}/product`], ['tests and checks', `${PROJECT}/tests`],
  ['workload', `${PROJECT}/workload`], ['knowledge', `${PROJECT}/knowledge`], ['team', `${PROJECT}/team`], ['integrations', `${PROJECT}/integrations`],
  ['organization', '/org'], ['roles', '/roles'], ['proposals', '/proposals'], ['cost center', '/costs'],
];

// The demo signs its sample owner in without a form, so no test ever types a password.
async function enter(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/401|Failed to load resource/.test(message.text())) errors.push(message.text()); });
  await page.goto('/demo/enter');
  await expect(page.getByRole('navigation').first()).toBeVisible();
  return errors;
}

test('signed out, the app shows the sign-in page; the gallery renders every primitive', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel(/password/i)).toBeVisible();
  await page.goto('/dev/ui');
  await expect(page.getByRole('button').first()).toBeVisible();
});

test('every screen renders on the demo data without an error', async ({ page }, info) => {
  const errors = await enter(page);
  for (const [name, route] of SCREENS) {
    await page.goto(route);
    await expect(page.locator('main'), name).toBeVisible();
    await expect(page.locator('main'), name).not.toBeEmpty();
    await expect(page.getByText(/something went wrong|not found/i), name).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`${name.replaceAll(' ', '-')}.png`) });
  }
  // An agent's page is reached from the roster beside a project.
  await page.goto(`${PROJECT}/tasks`);
  await page.locator('a[href^="/agents/"]').first().click();
  await expect(page).toHaveURL(/\/agents\//);
  await expect(page.locator('main')).not.toBeEmpty();
  expect(errors).toEqual([]);
});

test('a post to the discussion appears in the thread', async ({ page }) => {
  await enter(page);
  await page.goto(`${PROJECT}/tasks`);
  const text = `Smoke check ${Date.now()}`;
  const composer = page.getByRole('textbox').last();
  await composer.fill(text);
  await composer.press('Control+Enter');
  if (!(await page.getByText(text).count())) await page.getByRole('button', { name: /post|send/i }).last().click();
  await expect(page.getByText(text)).toBeVisible();
});

test('a proposal that needs the owner can be approved', async ({ page }) => {
  await enter(page);
  await page.goto('/proposals');
  await page.locator('a[href^="/proposals/"]').first().click();
  const approve = page.getByRole('button', { name: /^approve$/i });
  await expect(approve).toBeVisible();
  await approve.click();
  await expect(page.getByText(/approved/i).first()).toBeVisible();
});

test('the command palette opens on Ctrl + K and jumps to a screen, an agent and a project', async ({ page }) => {
  const errors = await enter(page);
  await page.goto(`${PROJECT}/tasks`);
  await expect(page.locator('main')).toBeVisible();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  for (const group of ['Projects', 'Agents', 'Screens']) await expect(palette.getByText(group, { exact: true })).toBeVisible();
  await palette.getByRole('combobox').fill('costs');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/costs$/);
  await expect(palette).toBeHidden();

  await page.keyboard.press('Control+k');
  const agent = palette.locator('[cmdk-item][data-value*="/agents/"]').first();
  await agent.click();
  await expect(page).toHaveURL(/\/agents\//);

  await page.keyboard.press('Control+k');
  await palette.getByRole('combobox').fill('checkout');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/p\/checkout-v2\/tasks$/);
  await page.keyboard.press('Control+k');
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  expect(errors).toEqual([]);
});

test('below 900 px the sidebar is a drawer and the discussion rail is a tab', async ({ page }, info) => {
  const errors = await enter(page);
  await page.setViewportSize({ width: 600, height: 900 });
  await page.goto(`${PROJECT}/tasks`);
  const sidebar = page.getByRole('navigation', { name: 'Projects and team' });
  await expect(sidebar).toBeHidden();
  await expect(page.getByRole('complementary', { name: 'Discussion' })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll').toBe(true);

  await page.getByRole('button', { name: 'Open navigation' }).click();
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await expect(drawer.getByRole('navigation', { name: 'Projects and team' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('drawer.png') });
  await drawer.getByRole('link', { name: 'Costs' }).click();
  await expect(page).toHaveURL(/\/costs$/);
  await expect(drawer).toBeHidden();

  await page.goto(`${PROJECT}/tasks`);
  await page.getByRole('tab', { name: 'Discussion' }).click();
  await expect(page.getByRole('complementary', { name: 'Discussion' })).toBeVisible();
  await expect(page.locator('main')).toBeHidden();
  await expect(page.getByRole('textbox').last()).toBeVisible();
  await page.screenshot({ path: info.outputPath('rail-tab.png') });
  await page.getByRole('tab', { name: 'Board' }).click();
  await expect(page.locator('main')).toBeVisible();

  // At the desktop width the three panes are back and the narrow bar is gone.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(sidebar).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden();
  expect(errors).toEqual([]);
});

test('markdown is rendered and sanitized in a real browser; mentions complete in the composer', async ({ page }) => {
  await page.goto('/dev/ui');
  const prose = page.locator('.prose').first();
  await expect(prose.locator('h2')).toHaveText('Checkout retries');
  await expect(prose.locator('table')).toBeVisible();
  await expect(prose.locator('script')).toHaveCount(0);
  await expect(prose.locator('img')).toHaveCount(1);
  expect(await prose.locator('img').evaluate(image => image.getAttributeNames().sort())).toEqual(['alt', 'src']);
  await expect(prose.locator('a')).toHaveAttribute('rel', 'noreferrer noopener');
  expect(await page.evaluate(() => [(window as any).galleryScriptRan, (window as any).galleryHandlerRan])).toEqual([undefined, undefined]);

  const composer = page.getByRole('textbox', { name: /Composer with @mention/ });
  await composer.pressSequentially('ask @cl');
  await expect(page.getByRole('listbox', { name: 'Mention' }).getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(composer).toHaveValue('ask @cleo ');
});

test('a new project can be created from the sidebar, given a connection, and left through its breadcrumb', async ({ page }, info) => {
  await enter(page);
  await page.goto(`${PROJECT}/tasks`);
  const name = `Pilot ${Date.now()}`;
  await page.getByRole('button', { name: /new project/i }).click();
  await page.getByPlaceholder('Web shop').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/p\/pilot-\d+\/integrations/);
  await expect(page.getByRole('navigation').first().getByText(name, { exact: true })).toBeVisible();

  // Guided setup: pick a product, read its steps, fill in its own fields, connect.
  await page.getByRole('button', { name: /connect something/i }).click();
  const flow = page.getByRole('dialog');
  for (const title of ['GitHub', 'GitLab', 'GitHub Issues', 'Linear', 'Slack', 'Google Drive']) await expect(flow.getByText(title, { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('connect-pick.png') });
  await flow.getByText('Slack', { exact: true }).click();
  await expect(flow.getByText('Before you connect')).toBeVisible();
  await page.screenshot({ path: info.outputPath('connect-slack.png') });
  await flow.getByPlaceholder('#checkout-team').fill('not a channel');
  await flow.getByRole('button', { name: 'Connect Slack' }).click();
  await expect(flow.getByText(/does not look right/)).toBeVisible();
  await flow.getByPlaceholder('#checkout-team').fill('#checkout-team');
  await flow.getByRole('button', { name: 'Test connection' }).click();
  await expect(flow.getByText(/is not set on the coordinator yet\. Set it/)).toBeVisible();
  await flow.getByRole('button', { name: 'Connect Slack' }).click();
  await expect(flow).toBeHidden();
  await expect(page.getByText(/Waiting for SLACK_BOT_TOKEN/)).toBeVisible();
  page.once('dialog', dialog => { void dialog.accept(); });
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText(/Waiting for SLACK_BOT_TOKEN/)).toHaveCount(0);

  // The breadcrumb leads back to the project, and from there to the organization.
  await page.locator('header').getByRole('link', { name }).click();
  await expect(page).toHaveURL(/\/p\/pilot-\d+\/tasks/);
  await page.locator('header').getByRole('link', { name: 'Acme' }).click();
  await expect(page).toHaveURL(/\/org/);
});
