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

  // Guided setup: pick a product, paste its token or leave it for later, fill in its own fields, connect.
  await page.getByRole('button', { name: /connect something/i }).click();
  const flow = page.getByRole('dialog');
  for (const title of ['GitHub', 'GitLab', 'GitHub Issues', 'Linear', 'Slack', 'Google Drive']) await expect(flow.getByText(title, { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('connect-pick.png') });
  await flow.getByText('Slack', { exact: true }).click();
  await expect(flow.getByLabel('Slack bot token')).toHaveAttribute('type', 'password');
  await expect(flow.getByText('Where do I get this?')).toBeVisible();
  await page.screenshot({ path: info.outputPath('connect-slack.png') });
  await flow.getByPlaceholder('#checkout-team').fill('not a channel');
  await flow.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(flow.getByText(/does not look right/)).toBeVisible();
  await flow.getByPlaceholder('#checkout-team').fill('#checkout-team');
  await flow.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(flow.getByText('Paste the Slack bot token first.')).toBeVisible();
  await flow.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(flow).toBeHidden();
  await expect(page.getByText('Needs a Slack bot token')).toBeVisible();
  page.once('dialog', dialog => { void dialog.accept(); });
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Needs a Slack bot token')).toHaveCount(0);

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
  for (const title of ['Claude subscription', 'Anthropic API', 'OpenRouter', 'Local models (Ollama)', 'Cursor agent']) await expect(flow.getByText(title, { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('provider-pick.png') });
  await flow.getByText('OpenRouter', { exact: true }).click();
  await expect(flow.getByText(/No worker is running yet/)).toBeVisible();
  // The key is typed here, and never shown again; nothing in the dialog runs longer than a line.
  await expect(flow.getByLabel('OpenRouter key')).toHaveAttribute('type', 'password');
  await expect(flow.locator('textarea')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('provider-openrouter.png') });

  // What was typed is answered in plain words, next to the field.
  // Models are ticked from the product's own list or found by typing; no name is written into the app.
  await expect(flow.getByRole('button', { name: /^Remove / })).toHaveCount(0);
  await flow.getByText('Limits', { exact: true }).click();
  await flow.getByLabel('Turns at once').fill('lots');
  await flow.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(flow.getByText('Choose at least one model')).toBeVisible();
  await expect(flow.getByText(/should be a whole number between 1 and 64/)).toBeVisible();
  await flow.locator('form').evaluate(form => { form.scrollTop = form.scrollHeight; });
  await page.screenshot({ path: info.outputPath('provider-errors.png') });
  for (const model of ['openrouter/vendor/model-a', 'openrouter/vendor/model-b']) { await flow.getByLabel('Search Models').fill(model); await flow.getByLabel('Search Models').press('Enter'); }
  await flow.getByLabel('Turns at once').fill('3');
  await flow.getByRole('button', { name: 'Add', exact: true }).click();
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

test('the Costs page says which currency it shows and an admin changes it and its rate in plain words', async ({ page }) => {
  const errors = await enter(page);
  await page.goto('/costs');
  await expect(page.getByText(/Costs are shown in EUR\. One US dollar counts as 1 EUR\./)).toBeVisible();
  await page.getByRole('button', { name: 'Change the currency' }).click();
  await page.getByLabel('Show costs in').fill('nok');
  await page.getByLabel(/One US dollar is worth this many NOK/).fill('10.5');
  await expect(page.getByText(/Earlier days are restated at this rate/)).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/Costs are shown in NOK\. One US dollar counts as 10\.5 NOK\./)).toBeVisible();
  // Put back what the other tests expect.
  await page.getByRole('button', { name: 'Change the currency' }).click();
  await page.getByLabel('Show costs in').fill('EUR');
  await page.getByLabel(/One US dollar is worth this many EUR/).fill('1');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/Costs are shown in EUR/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('harness health shows the cases on the base branch, what is quarantined as flaky, and what changed between runs', async ({ page }) => {
  const errors = await enter(page);
  const upload = (cases: string) => page.request.post('/api/projects/checkout-v2/checks/unit?branch=main', { headers: { 'content-type': 'application/xml' }, data: `<testsuite>${cases}</testsuite>` });
  expect((await upload('<testcase name="totals" time="1.5"/><testcase name="coupon race" time="0.5"/>')).ok()).toBe(true);
  expect((await upload('<testcase name="totals" time="1.5"/><testcase name="coupon race"><skipped message="quarantined: flaky"/></testcase><testcase name="tax" time="2"/>')).ok()).toBe(true);
  await page.goto(`${PROJECT}/tests`);
  await expect(page.getByText('Harness health', { exact: true })).toBeVisible();
  await expect(page.getByText('Cases on main')).toBeVisible();
  await expect(page.getByText('Quarantined as flaky', { exact: true })).toBeVisible();
  await expect(page.getByText(/1 case added, now 3 · quarantined as flaky: coupon race/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('knowledge: search, write a page, edit it past a stale save, read its history, restore a version and review stale memory', async ({ page }) => {
  const errors = await enter(page);
  await page.goto(`${PROJECT}/knowledge`);
  const main = page.locator('article');
  await page.getByRole('complementary', { name: 'Pages' }).getByRole('link', { name: 'Idempotency in checkout' }).click();
  await expect(main.getByRole('heading', { name: 'Idempotency in checkout' })).toBeVisible();
  // The page points at a decision; what is shown is the decision as it stands, with the way to its discussion.
  await expect(main.getByText(/Keep the Thursday deploy/)).toBeVisible();
  await expect(main.getByText('Waiting for a person to decide')).toBeVisible();
  await expect(main.getByText(/read by 3 agents today/)).toBeVisible();
  await expect(page.getByText(/used 4 times, last 3 days ago/)).toBeVisible();
  await page.screenshot({ path: 'walk-shots/knowledge-page.png' });

  const search = page.getByRole('searchbox', { name: 'Search knowledge' });
  await search.fill('safari');
  await expect(main.getByText('Memories', { exact: true })).toBeVisible();
  await expect(main.getByText('Issues', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'walk-shots/knowledge-search.png' });
  await search.fill('zzzz');
  await expect(main.getByText(/Nothing found for/)).toBeVisible();
  await search.fill('webhooks');
  await main.getByRole('button', { name: /Billing webhooks v2/ }).click();
  await expect(main.getByRole('heading', { name: 'Billing webhooks v2' })).toBeVisible();
  await expect(search).toHaveValue('');

  await page.getByRole('button', { name: 'New page' }).click();
  const stamp = Date.now(), title = `Refund rules ${stamp}`;
  await main.getByLabel('Title').fill(title);
  await main.getByLabel('Where it goes').selectOption({ label: 'In a new folder…' });
  await main.getByLabel('Name of the new folder').fill('Support');
  await main.getByLabel('What the page says').fill('# Refunds\n\n- Full refund within 14 days.\n- After that, store credit.');
  await main.getByLabel('Point at a decision').selectOption({ index: 1 });
  await main.getByRole('radio', { name: 'Preview' }).click();
  await expect(main.getByRole('heading', { name: 'Refunds' })).toBeVisible();
  await expect(main.locator('span').getByText(/Keep the Thursday deploy/)).toBeVisible();
  await page.screenshot({ path: 'walk-shots/knowledge-new.png' });
  await main.getByRole('button', { name: 'Save page' }).click();
  await expect(main.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Pages' }).getByText('▸ Support', { exact: true })).toBeVisible();

  // An edit made while someone else saved is refused, says so, and can still be saved on top.
  await main.getByRole('button', { name: 'Edit' }).click();
  await main.getByLabel('What the page says').fill('# Refunds\n\n- Full refund within 30 days.\n- After that, store credit.');
  await main.getByLabel('What changed').fill('Thirty days, as agreed with support');
  expect((await page.request.post('/api/projects/checkout-v2/knowledge', { data: { path: `support/refund-rules-${stamp}.md`, title, body: 'Someone else got here first.' } })).ok()).toBe(true);
  await main.getByRole('button', { name: 'Save changes' }).click();
  await expect(main.getByText('Someone else changed this page while you were writing')).toBeVisible();
  await page.screenshot({ path: 'walk-shots/knowledge-stale.png' });
  await main.getByRole('button', { name: 'Save mine on top' }).click();
  await expect(main.getByText('Full refund within 30 days.')).toBeVisible();
  await expect(main.getByText(/Version 3, saved/)).toBeVisible();

  await main.getByRole('button', { name: 'History' }).click();
  await expect(main.getByRole('button', { name: /Version 3 .* Thirty days, as agreed with support/ })).toBeVisible();
  await main.getByRole('button', { name: /Version 1 / }).click();
  await expect(main.getByRole('table', { name: /Changes to support\/refund-rules/ })).toContainText('Full refund within 14 days.');
  await page.screenshot({ path: 'walk-shots/knowledge-history.png', fullPage: true });
  await main.getByRole('button', { name: 'Restore this version' }).click();
  await expect(main.getByRole('button', { name: /Version 4 .* Restored version 1/ })).toBeVisible();
  await main.getByRole('button', { name: 'Back to the page' }).click();
  await expect(main.getByText('Full refund within 14 days.')).toBeVisible();

  // Memory nobody has used for two months comes up for review.
  const rail = page.getByRole('complementary', { name: 'Memory' });
  await rail.getByRole('radio', { name: /Review stale \(1\)/ }).click();
  await expect(rail.getByText(/manual cache flush/)).toBeVisible();
  await page.screenshot({ path: 'walk-shots/knowledge-stale-memory.png' });
  await rail.getByRole('button', { name: 'Still true' }).click();
  await expect(rail.getByRole('radio', { name: /Review stale/ })).toHaveCount(0);

  // Knowledge is kept at more than one level.
  await page.getByRole('radio', { name: 'Acme' }).click();
  await expect(main.getByText('Nothing written here yet')).toBeVisible();
  await page.screenshot({ path: 'walk-shots/knowledge-org-empty.png' });
  expect(errors).toEqual([]);
});

test('the Tests tab shows the branch matrix with who is on a failure, and says how results arrive when there are none', async ({ page }) => {
  const errors = await enter(page);
  await page.goto(`${PROJECT}/tests`);
  await expect(page.getByText(/pay-button\.spec › comes back after a network drop/)).toBeVisible();
  await expect(page.getByText(/Bram is on it \(CK-28\)/)).toBeVisible();
  await expect(page.getByText(/cart\.spec › keeps the cart across a reload/).first()).toBeVisible();
  await page.screenshot({ path: 'walk-shots/tests-matrix.png', fullPage: true });
  await page.goto('/p/search-rework/tests');
  await expect(page.getByText('No test results yet')).toBeVisible();
  await expect(page.getByText('How results get here')).toBeVisible();
  await page.screenshot({ path: 'walk-shots/tests-empty.png' });
  await page.getByLabel('What do these results cover?').fill('Unit tests');
  await page.getByLabel('Results file').setInputFiles({ name: 'results.xml', mimeType: 'text/xml', buffer: Buffer.from('<testsuite><testcase name="totals" time="1.5"/><testcase name="tax"><failure message="expected 25, got 24"/></testcase></testsuite>') });
  await page.getByRole('button', { name: 'Upload results' }).click();
  await expect(page.getByText(/tax — expected 25, got 24/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('what needs a person is one click away, and a decision is recorded in their own words', async ({ page }, info) => {
  const errors = await enter(page);
  await page.goto(`${PROJECT}/tasks`);
  const link = page.getByRole('navigation').first().getByRole('link', { name: /needs you/i });
  await expect(link).toContainText(/[1-9]/);
  await link.click();
  await expect(page).toHaveURL(/\/needs-you$/);
  const card = page.locator('main').getByText(/Keep the Thursday deploy/).locator('xpath=ancestor::*[.//button][1]');
  await page.screenshot({ path: info.outputPath('needs-you.png') });
  await expect(card.getByRole('button', { name: 'Record the decision' })).toBeDisabled();
  await card.getByRole('textbox').fill('Test first and ship Friday.');
  await card.getByRole('button', { name: 'Record the decision' }).click();
  await expect(page.getByText(/Keep the Thursday deploy/)).toHaveCount(0);
  await page.goto(`${PROJECT}/tasks`);
  await expect(page.getByText('Test first and ship Friday.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('single sign-on is set up through a guided flow, checked, shown in sentences and turned off; a token is shown once to copy', async ({ page, baseURL }) => {
  const errors = await enter(page);
  await page.goto('/settings/auth');
  await expect(page.getByText(/8 failed sign-ins lock an account for 15 minutes/)).toBeVisible();
  await page.getByRole('button', { name: 'Set up single sign-on' }).click();
  const flow = page.getByRole('dialog');
  for (const title of ['Google Workspace', 'Microsoft Entra ID', 'Okta', 'Auth0', 'Keycloak', 'Another OpenID Connect provider']) await expect(flow.getByText(title, { exact: true })).toBeVisible();
  await page.screenshot({ path: 'walk-shots/sso-pick.png' });

  // The address to paste with a copy button, the product's own words one click away, and the secret typed here once.
  await flow.getByText('Microsoft Entra ID', { exact: true }).click();
  await expect(flow.getByText(`${baseURL}/api/auth/oidc/callback`)).toBeVisible();
  await expect(flow.getByRole('button', { name: 'Copy' })).toBeVisible();
  await flow.getByText('How to register this app').click();
  await expect(flow.getByText(/App registrations and choose New registration/)).toBeVisible();
  await expect(flow.getByLabel('Client secret')).toHaveAttribute('type', 'password');
  await flow.getByLabel('Client secret').fill('a-client-secret-value');
  await page.screenshot({ path: 'walk-shots/sso-steps.png' });
  await flow.getByLabel('Directory (tenant) ID').fill('contoso');
  await flow.getByLabel('Application (client) ID').fill('3fa85f64-5717-4562-b3fc-2c963f66afa6');
  await flow.getByRole('button', { name: 'Turn on' }).click();
  await expect(flow.getByText(/Directory \(tenant\) ID does not look right; it should look like/)).toBeVisible();

  // Any other product: this coordinator's own address is not a sign-in service, and the check says so without leaving the machine.
  await flow.getByRole('button', { name: /Back/ }).click();
  await flow.getByText('Another OpenID Connect provider', { exact: true }).click();
  await flow.getByLabel('Issuer address').fill(baseURL!);
  await flow.getByLabel('Client ID').fill('agent-team');
  await flow.getByLabel('Client secret').fill('a-client-secret-value');
  await flow.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(flow.getByText('That address does not answer as a sign-in service.')).toBeVisible();
  await flow.getByText('Who may sign in').click();
  await flow.getByLabel(/Email domains/).fill('example.com, example.org');
  await flow.locator('form').evaluate(form => { form.parentElement!.scrollTop = form.parentElement!.scrollHeight; });
  await page.screenshot({ path: 'walk-shots/sso-check.png' });
  await flow.getByRole('button', { name: 'Turn on' }).click();
  await expect(flow).toBeHidden();

  await expect(page.getByText('Open to example.com or example.org · new people join as viewer')).toBeVisible();
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(page.getByText('That address does not answer as a sign-in service.')).toBeVisible();
  await page.screenshot({ path: 'walk-shots/sso-on.png' });
  await page.getByRole('button', { name: 'Turn off' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByRole('button', { name: 'Set up single sign-on' })).toBeVisible();

  // A token for a worker: shown once, in a block with its own copy button.
  await expect(page.getByText('Tokens for workers and the command line')).toBeVisible();
  await page.getByLabel('Name').fill('build box');
  await page.getByRole('button', { name: 'Create token' }).click();
  await expect(page.getByText(/Copy this token now; it is not shown again/)).toBeVisible();
  await expect(page.locator('pre')).toHaveText(/\S{20,}/);
  await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
  await page.locator('main').getByText(/Copy this token now/).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'walk-shots/signin.png' });
  await page.getByRole('button', { name: 'Done, I copied it' }).click();
  await expect(page.locator('pre')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an accent button has dark text on it, not the light text of the page', async ({ page }) => {
  await page.goto('/dev/ui');
  const button = page.getByRole('button', { name: 'primary', exact: true }).first();
  const [text, background] = await button.evaluate(node => { const style = getComputedStyle(node); return [style.color, style.backgroundColor]; });
  const light = (value: string) => { const [r, g, b] = (value.match(/[\d.]+/g) ?? []).map(Number); return (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255; };
  // Dark on amber: the text must be much darker than what it sits on.
  expect(light(background) - light(text)).toBeGreaterThan(0.4);
});
