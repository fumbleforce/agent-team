import { expect, test, type Page } from '@playwright/test';

const PROJECT = '/p/checkout-v2';
const SCREENS: [string, string][] = [
  ['task board', `${PROJECT}/tasks`], ['issues', `${PROJECT}/issues`], ['product view', `${PROJECT}/product`], ['tests and checks', `${PROJECT}/tests`],
  ['workload', `${PROJECT}/workload`], ['knowledge', `${PROJECT}/knowledge`], ['team', `${PROJECT}/team`], ['integrations', `${PROJECT}/integrations`],
  ['organization', '/org'], ['roles', '/roles'], ['agent library', '/library'], ['proposals', '/proposals'], ['cost center', '/costs'],
  // The studio: a project that is not software, with checks, its own connections and a tab of its own.
  ...['tasks', 'issues', 'product', 'checks', 'workload', 'knowledge', 'team', 'integrations'].map((tab): [string, string] => [`studio ${tab}`, `/p/nordlys-studio/${tab}`]),
  ['studio settings', '/settings/project/nordlys-studio'],
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

test('a model provider is added through its guided setup, and an agent is created, given it, reordered and retired', async ({ page }, info) => {
  const errors = await enter(page);
  await page.goto(`${PROJECT}/team`);
  await page.getByRole('button', { name: /add a model provider/i }).click();
  const flow = page.getByRole('dialog');
  for (const title of ['Claude subscription (Pro or Max)', 'Anthropic API (pay per use)', 'OpenRouter', 'Local models (Ollama)', 'Cursor agent']) await expect(flow.getByText(title, { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('provider-pick.png') });
  await flow.getByText('OpenRouter', { exact: true }).click();
  await expect(flow.getByText('On each worker machine', { exact: true })).toBeVisible();
  await expect(flow.getByText(/No worker is running yet/)).toBeVisible();
  await expect(flow.getByText(/lives on the worker machines as OPENROUTER_API_KEY; it is never entered here/)).toBeVisible();
  await page.screenshot({ path: info.outputPath('provider-openrouter.png') });

  // What was typed is answered in plain words, next to the field.
  const models = flow.getByLabel('Models the team may use');
  await expect(models).toHaveValue(/openrouter\//);
  await models.fill('two words');
  await flow.getByLabel(/Agents working at the same time/).fill('lots');
  await flow.getByRole('button', { name: 'Add this provider' }).click();
  await expect(flow.getByText(/each model goes on its own line, without spaces/)).toBeVisible();
  await expect(flow.getByText(/should be a whole number between 1 and 64/)).toBeVisible();
  await flow.locator('form').evaluate(form => { form.scrollTop = form.scrollHeight; });
  await page.screenshot({ path: info.outputPath('provider-errors.png') });
  await models.fill('openrouter/vendor/model-a\nopenrouter/vendor/model-b');
  await flow.getByLabel(/Agents working at the same time/).fill('3');
  await flow.getByRole('button', { name: 'Add this provider' }).click();
  await expect(flow).toBeHidden();
  const card = page.locator('article, div').filter({ hasText: /^OpenRouterPay per use/ }).first();
  await expect(card).toBeVisible();
  await expect(page.getByText('No agent uses it yet · 3 at a time')).toBeVisible();

  // A new seat, in the product's words: name, what they do, persona, roles with their summaries, and what it runs on.
  await page.getByRole('button', { name: /add an agent/i }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Noor Hale');
  await dialog.getByLabel(/What they do on the team/).fill('Release tester');
  await dialog.getByLabel(/Personality and way of working/).fill('Careful. Tries the unhappy path first.');
  await dialog.getByRole('checkbox').first().check();
  await dialog.getByLabel('Runs on').selectOption({ label: 'OpenRouter · openrouter/vendor/model-b' });
  await page.screenshot({ path: info.outputPath('agent-new.png') });
  await dialog.getByRole('button', { name: 'Add to the team' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel('Provider and model for Noor Hale')).toHaveValue(/model-b$/);
  await expect(page.getByText('1 agent · 3 at a time')).toBeVisible();

  // Up one seat, then out again: a provider in use cannot be removed, and says so.
  await page.getByRole('button', { name: 'Move Noor Hale up' }).click();
  await expect(page.getByRole('button', { name: 'Move Noor Hale down' })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('team-with-provider.png'), fullPage: true });
  page.once('dialog', dialog => { void dialog.accept(); });
  await page.getByRole('button', { name: 'Remove', exact: true }).first().click();
  await expect(page.getByText(/Noor Hale still runs on OpenRouter/)).toBeVisible();
  await page.getByRole('button', { name: 'More for Noor Hale' }).click();
  await page.screenshot({ path: info.outputPath('seat-menu.png') });
  page.once('dialog', dialog => { void dialog.accept(); });
  await page.getByRole('menuitem', { name: 'Retire…' }).click();
  await expect(page.getByLabel('Provider and model for Noor Hale')).toHaveCount(0);
  page.once('dialog', dialog => { void dialog.accept(); });
  await page.getByRole('button', { name: 'Remove', exact: true }).first().click();
  await expect(page.getByText('No provider yet.', { exact: false })).toBeVisible();

  // The agent library has its own small editor: what is kept there can be hired into any team.
  await page.goto('/library');
  await page.getByRole('button', { name: /add an agent to the library/i }).click();
  const library = page.getByRole('dialog');
  await library.getByLabel('Name').fill('Sol Reyes');
  await library.getByLabel(/What they do/).fill('Security reviewer');
  await library.getByRole('checkbox').nth(2).check();
  await page.screenshot({ path: info.outputPath('library-new.png') });
  await library.getByRole('button', { name: 'Add to the library' }).click();
  await expect(library).toBeHidden();
  await expect(page.getByText('Sol Reyes')).toBeVisible();
  await page.screenshot({ path: info.outputPath('library.png') });
  expect(errors).toEqual([]);
});

test('the studio is a project that is not software: checks, a tab of its own, handoffs in both directions', async ({ page }) => {
  const errors = await enter(page);
  await page.goto('/p/nordlys-studio/tasks');
  const tabs = page.locator('header nav');
  await expect(tabs.getByRole('link', { name: 'Checks' })).toBeVisible();
  await expect(tabs.getByRole('link', { name: 'Tests' })).toHaveCount(0);
  const calendar = tabs.getByRole('link', { name: /Editorial calendar/ });
  await expect(calendar).toHaveAttribute('target', '_blank');
  await expect(calendar).toHaveAttribute('href', 'https://calendar.nordlys.example/editorial');
  await tabs.getByRole('link', { name: 'Checks' }).click();
  await expect(page.getByText('Fact check').first()).toBeVisible();

  // An incoming handoff goes onto a task; the outbound one waits until its result is written down.
  await page.goto('/p/nordlys-studio/integrations');
  const panel = page.getByRole('complementary', { name: 'Handoffs' });
  await panel.getByRole('button', { name: 'Attach to a task' }).click();
  await panel.getByLabel('Which task is this for?').selectOption({ label: 'NS-12 · Check the ferry timetable piece' });
  await panel.getByRole('button', { name: 'Attach', exact: true }).click();
  await expect(panel.getByText('Attached to NS-12 · Check the ferry timetable piece')).toBeVisible();
  await expect(panel.getByText('Waiting for a result')).toBeVisible();
  await panel.getByRole('button', { name: 'Record the result' }).click();
  await panel.getByLabel('What came back?').fill('Proofs approved on the heavier stock.');
  await panel.getByRole('button', { name: 'Save the result' }).click();
  await expect(panel.getByText('Result: Proofs approved on the heavier stock.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a project budget is set on the Costs page in the organization currency', async ({ page }) => {
  const errors = await enter(page);
  await page.goto('/costs');
  await page.getByRole('button', { name: 'Set a budget' }).first().click();
  await page.getByLabel(/Budget per month in EUR/).fill('250');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/of €250 this month/)).toBeVisible();
  expect(errors).toEqual([]);
});
