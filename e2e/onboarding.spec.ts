import { expect, test } from '@playwright/test';

const EMPTY = 'http://127.0.0.1:4392';

test('a new organization is guided from nothing to a connected project, one step at a time', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${EMPTY}/demo/enter`);
  // With nothing set up, the app opens on the guide instead of an empty board.
  await expect(page).toHaveURL(/\/welcome/);
  await expect(page.getByRole('heading', { name: /welcome/i })).toBeVisible();
  await expect(page.getByText(/0 of 5 done/)).toBeVisible();
  await page.screenshot({ path: info.outputPath('welcome-start.png'), fullPage: true });

  const project = page.getByRole('region', { name: 'Create your first project' });
  await project.getByRole('button', { name: 'Create your first project' }).click();
  await page.getByPlaceholder('Web shop').fill('Web shop');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/welcome\?project=web-shop/);
  await expect(page.getByText(/1 of 5 done/)).toBeVisible();

  // The next open step is the code host, through the same guided dialog as everywhere else.
  const code = page.getByRole('region', { name: 'Connect where the code lives' });
  await code.getByRole('button', { name: 'Connect a code host' }).click();
  const flow = page.getByRole('dialog');
  await expect(flow.getByText('Task boards')).toHaveCount(0);
  await flow.getByText('GitHub', { exact: true }).click();
  await flow.getByPlaceholder('owner/name').fill('acme/web-shop');
  await flow.getByRole('button', { name: 'Connect GitHub' }).click();
  await expect(flow).toBeHidden();
  await expect(code.getByText(/Connected: acme\/web-shop/)).toBeVisible();

  // The worker step writes the exact command, with a token made here and shown once.
  const worker = page.getByRole('region', { name: 'Start a worker next to the code' });
  await worker.getByText('Do this now').click();
  await worker.getByRole('button', { name: 'Make a token for this worker' }).click();
  await expect(worker.locator('pre')).toContainText(/AGENT_TEAM_TOKEN.*mt_/);
  await expect(worker.locator('pre')).toContainText('work "');
  await expect(worker.locator('pre')).toContainText('--project web-shop --url http://127.0.0.1:4392');
  await page.screenshot({ path: info.outputPath('welcome-progress.png'), fullPage: true });

  // The sidebar keeps the way back, with progress, on every screen.
  await page.goto(`${EMPTY}/p/web-shop/tasks`);
  await expect(page.getByRole('navigation').first().getByRole('link', { name: /get started/i })).toContainText('2 of 5');
  expect(errors).toEqual([]);
});
