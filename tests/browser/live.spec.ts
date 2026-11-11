import { test, expect, chromium, _electron, type Page, type Locator } from '@playwright/test';
import { readFile, mkdir, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';

// Explicit fixture paths only. These tests never connect to a production home.
const home = process.env.HERMES_TEST_HOME;
const url = process.env.HERMES_TEST_URL || 'http://127.0.0.1:19120';
const id = 'hermes-chat-git-hash-differ';
test.skip(!home, 'Set HERMES_TEST_HOME to a running prepare_live.py fixture.');
async function setReviewed(pane: Locator, value: boolean) {
  const box = pane.getByRole('checkbox', { name: 'Reviewed', exact: true });
  if (await box.isChecked() !== value) await box.click();
  await expect(box).toBeChecked({ checked: value });
  await expect(box).toBeEnabled();
}

async function openChat(page: Page) {
  await page.getByText('Review twenty commits', { exact: true }).first().click({ timeout: 60000 });
  await expect(page.getByRole('button', { name: /Commits · 20/ })).toBeVisible({ timeout: 60000 });
  if (!await page.locator('.hgd-pane').isVisible()) await page.getByRole('button', { name: /Commits · 20/ }).click();
  const pane = page.locator('.hgd-pane').last();
  await pane.getByLabel('Search commits').fill('step 20');
  await pane.getByText('Refine release step 20', { exact: true }).click();
  await expect(pane.getByRole('list', { name: 'File diff' })).toContainText('export const version = 19');
  return pane;
}

test('Webapp: real 20-commit review, expansion, settings, and cross-client persistence', async ({}, testInfo) => {
  const token = (await readFile(path.join(home!, 'webapp/session-token'), 'utf8')).trim();
  const browser = await chromium.launch({ channel: process.env.HERMES_TEST_BROWSER || 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ token, id }) => {
    sessionStorage.setItem(`hermes.webapp.session.v1:${JSON.stringify([location.origin, ''])}`, token);
    localStorage.setItem('hermes.desktop.pluginDecisions.v2', JSON.stringify({ [id]: true }));
  }, { token, id });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  try {
    await page.goto(url);
    let pane = await openChat(page);
    await setReviewed(pane, false);
    await setReviewed(pane, true);
    await expect(pane).toContainText('1 of 1 files reviewed');
    await page.screenshot({ path: testInfo.outputPath('webapp-panel.png') });
    const selected = await pane.getByLabel('Selected commit').inputValue();
    await pane.getByRole('button', { name: 'Expand ↗' }).click();
    pane = page.locator('.hgd-expanded');
    await expect(pane.getByLabel('Selected commit')).toHaveValue(selected);
    await expect(pane.getByRole('checkbox', { name: 'Reviewed', exact: true })).toBeChecked();
    await expect(pane.getByLabel('Diff layout')).toHaveValue('split');
    await pane.getByLabel('Diff layout').selectOption('unified');
    await expect(pane.getByRole('list', { name: 'File diff' })).toContainText('export const version = 18');
    await pane.getByRole('button', { name: 'More context' }).click();
    await expect(pane).toContainText('20 context lines');
    await expect(pane.getByRole('list', { name: 'File diff' })).toContainText('export const version = 19');
    await page.screenshot({ path: testInfo.outputPath('webapp-expanded.png') });
    await pane.getByRole('button', { name: 'Next commit' }).click();
    await expect(pane.getByLabel('Selected commit')).not.toHaveValue(selected);
    await pane.getByRole('button', { name: 'Previous commit' }).click();
    await expect(pane.getByRole('checkbox', { name: 'Reviewed', exact: true })).toBeChecked();
    await pane.getByRole('button', { name: 'Plugin settings' }).click();
    await pane.getByRole('switch', { name: 'Automatically open the commit panel' }).click();
    await expect(pane.getByRole('switch')).toHaveAttribute('aria-checked', 'false');

    const other = await context.newPage();
    await other.goto(url);
    await other.getByText('Review twenty commits', { exact: true }).first().click({ timeout: 60000 });
    await expect(other.getByRole('button', { name: /Commits · 20/ })).toBeVisible({ timeout: 60000 });
    await expect(other.locator('.hgd-pane')).toHaveCount(0);
    await other.getByRole('button', { name: /Commits · 20/ }).click();
    const second = await openChat(other);
    await expect(second.getByRole('checkbox', { name: 'Reviewed', exact: true })).toBeChecked();
    await setReviewed(second, false);
    // Reopening the first client's review picks up a change made by another client.
    await pane.getByRole('button', { name: 'Plugin settings' }).click();
    await expect(pane.getByRole('checkbox', { name: 'Reviewed', exact: true })).not.toBeChecked({ timeout: 15000 });
    await setReviewed(pane, true);
    await pane.getByRole('button', { name: 'Plugin settings' }).click();
    await pane.getByRole('switch').click();
    await expect(pane.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
});

test('Desktop: actual packaged app with remote gateway and shared review state', async ({}, testInfo) => {
  const executablePath = process.env.HERMES_TEST_DESKTOP;
  test.skip(!executablePath, 'Set HERMES_TEST_DESKTOP to the packaged Hermes executable.');
  const desktopHome = testInfo.outputPath('hermes-home');
  const userData = testInfo.outputPath('electron-data');
  await mkdir(desktopHome, { recursive: true });
  await mkdir(userData, { recursive: true });
  const token = (await readFile(path.join(home!, 'webapp/session-token'), 'utf8')).trim();
  await writeFile(path.join(desktopHome, 'gateway-connections.json'), JSON.stringify({ version: 2, revision: 1, primary: 'fixture', launchMode: 'primary', lastUsed: 'fixture', connections: [
    { id: 'local', kind: 'local', label: 'Test device' },
    { id: 'fixture', kind: 'remote', label: 'Fixture host', url, authMode: 'token', token: { encoding: 'plain', value: token } },
  ] }));
  await cp('desktop', path.join(desktopHome, 'desktop-plugins', id), { recursive: true });
  const app = await _electron.launch({ executablePath, env: { ...process.env, HERMES_HOME: desktopHome,
    HERMES_DESKTOP_USER_DATA_DIR: userData, HERMES_DESKTOP_APP_NAME: `HermesPluginTest-${Date.now()}`,
    HERMES_DESKTOP_IGNORE_EXISTING: '1', HERMES_DESKTOP_ISOLATED_BACKEND: '1',
    HERMES_DESKTOP_SKIP_QUIT_CONFIRM: '1', HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION: '1', HERMES_DISABLE_LAZY_INSTALLS: '1',
  }, timeout: 60000 });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(win => { win.webContents.setBackgroundThrottling(false); win.setSize(1600, 1100); win.hide(); }));
    await page.evaluate(id => localStorage.setItem('hermes.desktop.pluginDecisions.v2', JSON.stringify({ [id]: true })), id);
    await page.reload();
    const pane = await openChat(page);
    await expect(pane.getByRole('checkbox', { name: 'Reviewed', exact: true })).toBeChecked();
    await pane.getByRole('button', { name: 'Expand ↗' }).click();
    await expect(page.locator('.hgd-expanded').getByLabel('Selected commit')).toContainText('Refine release step 20');
  } finally { await app.close(); }
});
