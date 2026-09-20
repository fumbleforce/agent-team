import { expect, test } from '@playwright/test';

const EMPTY = 'http://127.0.0.1:4392';

test('a new organization is guided from nothing to a connected project, one step at a time', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${EMPTY}/demo/enter`);
  // With nothing set up, the app opens on the guide instead of an empty board.
  await expect(page).toHaveURL(/\/welcome/);
  await expect(page.getByRole('heading', { name: /welcome/i })).toBeVisible();
  await expect(page.getByText(/0 of 4 done/)).toBeVisible();
  await page.screenshot({ path: info.outputPath('welcome-start.png'), fullPage: true });

  const project = page.getByRole('region', { name: 'Create your first project' });
  await project.getByRole('button', { name: 'Create your first project' }).click();
  await page.getByPlaceholder('Web shop').fill('Web shop');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/welcome\?project=web-shop/);
  await expect(page.getByText(/1 of 4 done/)).toBeVisible();

  // One step for the code: first the repository, through the same guided dialog as everywhere else…
  const code = page.getByRole('region', { name: 'Connect the code' });
  await code.getByRole('button', { name: 'Connect a code host' }).click();
  const flow = page.getByRole('dialog');
  await expect(flow.getByText('Task boards')).toHaveCount(0);
  await flow.getByText('GitHub', { exact: true }).click();
  await flow.getByPlaceholder('owner/name').fill('acme/web-shop');
  await flow.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(flow).toBeHidden();
  await expect(code.getByText('acme/web-shop is connected.')).toBeVisible();

  // …then something to work on it. On this machine that is one button; a folder or another machine are the ways out.
  await expect(code.getByRole('button', { name: 'Start working on it here' })).toBeVisible();
  await code.getByRole('button', { name: 'I already have it in a folder' }).click();
  await code.getByRole('textbox').fill('/no/such/folder');
  await code.getByRole('button', { name: 'Start working from that folder' }).click();
  await expect(code.getByText('There is no folder at that path on this machine')).toBeVisible();
  await code.getByRole('button', { name: 'Back' }).click();
  await code.getByRole('button', { name: 'Use another machine' }).click();
  await code.getByRole('button', { name: /Get the command/ }).click();
  await expect(code.locator('pre')).toHaveText(/^agent-team connect http:\/\/127\.0\.0\.1:4392\/pair\/[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  await page.screenshot({ path: info.outputPath('welcome-progress.png'), fullPage: true });

  // The sidebar keeps the way back, with progress, on every screen.
  await page.goto(`${EMPTY}/p/web-shop/tasks`);
  await expect(page.getByRole('navigation').first().getByRole('link', { name: /get started/i })).toContainText('1 of 4');
  expect(errors).toEqual([]);
});
