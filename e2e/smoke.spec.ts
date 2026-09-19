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
