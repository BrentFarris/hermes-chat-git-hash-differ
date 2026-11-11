import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { JSDOM } from 'jsdom';
import { ReviewController, shouldAutoOpen } from '../src/controller';
import { ReviewPane, VirtualList, diffRows } from '../src/review';
import { PluginApp } from '../src/plugin';
import { CommitStrip } from '../src/composer';
import { host, atom } from './sdk-fixture';
import type { Snapshot, Listing, Route } from '../src/types';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { constructor(private fn: any) {} observe() { this.fn([{ contentRect: { width: 1200 } }]); } disconnect() {} } });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
// React DOM detects input-event support at import time; initialize the DOM first.
const { render, fireEvent, cleanup, waitFor, act } = await import('@testing-library/react');
const route: Route = { connectionId: 'local', profile: 'default', targetProfile: 'default', mode: 'local', sessionId: 'chat', storedId: 'chat' };
function storage() { const values = new Map(); return { get: <T,>(key: string, fallback: T): T => values.has(key) ? values.get(key) : fallback, set: (key: string, value: any) => values.set(key, value) }; }
function snapshot(): Snapshot { return { session: { id: 'chat', title: 'Fixture chat' }, commits: Array.from({ length: 20 }, (_, i) => ({ id: `r:${i}`, sha: i.toString(16).padStart(40, 'a'), subject: `Change ${i}`, author: 'Fixture', date: '', parents: ['parent'], parent: 'parent', repo_id: 'r', repo_name: 'repo', file_count: 2, reviewed_count: 0, occurrences: 1 })), repositories: [{ id: 'r', name: 'repo', path: '/repo' }], unresolved: [], errors: [], scanning: false, auto_open: true }; }
function listing(): Listing { return { commit: snapshot().commits[0], parent: 'parent', files: [
  { id: 'f1', path: 'src/a.ts', old_path: 'src/a.ts', status: 'M', added: 1, deleted: 1, binary: false, reviewed: false },
  { id: 'f2', path: 'src/b.ts', old_path: 'src/b.ts', status: 'A', added: 1, deleted: 0, binary: false, reviewed: false }] }; }
const diff = { kind: 'text', hunks: [{ header: '@@ -1 +1 @@', lines: [{ kind: 'delete' as const, text: 'before', old: 1, new: null }, { kind: 'add' as const, text: 'after', old: null, new: 1 }] }] };
function fixture() {
  const saved = storage(); const list = listing(); const snap = snapshot(); const calls: any[] = [];
  const rpc: any = async (_route: Route, method: string, params: any = {}) => {
    calls.push([method, params]);
    if (method.startsWith('session.')) return structuredClone(snap);
    if (method === 'settings.set') { snap.auto_open = params.auto_open; return { auto_open: params.auto_open }; }
    if (method === 'review.set') list.files.find(f => f.id === params.file_id)!.reviewed = params.reviewed;
    if (method === 'commit.files' || method === 'review.set') return structuredClone({ ...list, parent: params.parent ?? list.parent, commit: snap.commits.find(c => c.id === params.commit_id) || list.commit });
    return diff;
  };
  return { ctrl: new ReviewController(route, rpc, saved), rpc, saved, calls, snap, list };
}
afterEach(() => cleanup());

test('auto-open defaults on, respects setting, and remembers manual dismissal', async () => {
  const { ctrl, saved } = fixture(); await ctrl.refresh(); assert.ok(shouldAutoOpen(ctrl, saved));
  await ctrl.autoOpen(false); assert.equal(shouldAutoOpen(ctrl, saved), false);
  await ctrl.autoOpen(true); saved.set(`opened:${ctrl.key}`, true); await ctrl.refresh();
  assert.equal(shouldAutoOpen(ctrl, saved), false); ctrl.dispose();
});
test('new hashes preserve selection; navigation and scroll survive reopening', async () => {
  const { ctrl, saved, rpc } = fixture(); await ctrl.refresh(); await ctrl.selectCommit('r:0'); await ctrl.selectFile('f2'); ctrl.rememberScroll(120);
  await ctrl.refresh(); assert.equal(ctrl.state.fileId, 'f2'); assert.equal(ctrl.scrollTop(), 120);
  const reopened = new ReviewController(route, rpc, saved); await reopened.refresh(); await reopened.selectCommit('r:0');
  assert.equal(reopened.state.fileId, 'f2'); assert.equal(reopened.scrollTop(), 120); ctrl.dispose(); reopened.dispose();
});
test('a late file response cannot overwrite the newer selection', async () => {
  const { ctrl } = fixture(); await ctrl.refresh(); await ctrl.selectCommit('r:0');
  let finish!: (value: any) => void;
  ctrl.rpc = (async (_r, method, params) => method === 'file.diff' && params?.file_id === 'f1' ? new Promise(resolve => { finish = resolve; }) : { ...diff, message: 'second' }) as any;
  const old = ctrl.selectFile('f1'); await ctrl.selectFile('f2'); finish({ ...diff, message: 'stale' }); await old;
  assert.equal(ctrl.state.fileId, 'f2'); assert.equal(ctrl.state.diff?.message, 'second'); ctrl.dispose();
});

test('gateway/profile identities isolate client navigation and stale runtime replies', async () => {
  const { ctrl, saved, rpc } = fixture();
  await ctrl.refresh();
  saved.set(`opened:${ctrl.key}`, true);
  const other = new ReviewController({ ...route, connectionId: 'remote', profile: 'other' }, rpc, saved);
  await other.refresh();
  assert.ok(shouldAutoOpen(other, saved));
  let finish!: (value: any) => void;
  ctrl.rpc = (() => new Promise(resolve => { finish = resolve; })) as any;
  const old = ctrl.selectCommit('r:0');
  ctrl.updateRoute({ ...route, sessionId: 'new-runtime' });
  finish(listing()); await old;
  assert.equal(ctrl.state.listing, null);
  ctrl.dispose(); other.dispose();
});

test('keyboard file navigation skips directory headers', async () => {
  const view = render(<VirtualList items={['folder one', 'a.ts', 'folder two', 'b.ts']} label="Files" focusable={value => value.endsWith('.ts')} render={value => value.endsWith('.ts') ? <button>{value}</button> : <span>{value}</span>}/>);
  view.getByText('a.ts').focus();
  fireEvent.keyDown(view.getByText('a.ts'), { key: 'ArrowDown' });
  await waitFor(() => assert.equal(document.activeElement?.textContent, 'b.ts'));
});
test('explicit reviewed changes persist and failed saves do not claim completion', async () => {
  const { ctrl } = fixture(); await ctrl.refresh(); await ctrl.selectCommit('r:0');
  assert.equal(ctrl.state.listing!.files[0].reviewed, false); await ctrl.review('f1', true);
  assert.equal(ctrl.state.listing!.files[0].reviewed, true);
  ctrl.rpc = async () => { throw new Error('Offline'); }; await ctrl.review('f2', true);
  assert.equal(ctrl.state.listing!.files[1].reviewed, false); assert.match(ctrl.state.error, /Offline/); ctrl.dispose();
});
test('split hunks pair deletions and additions without dropping context', () => {
  assert.equal(diffRows(diff, true).length, 2); assert.equal(diffRows(diff, false).length, 3);
  const rows = diffRows(diff, true); assert.equal('left' in rows[1] && rows[1].left?.text, 'before');
});
test('20-commit UI navigates files, marks review, and expands the same controller', async () => {
  const { ctrl } = fixture(); await ctrl.refresh(); let expanded = false;
  const view = render(<ReviewPane ctrl={ctrl} expand={() => { expanded = true; }}/>);
  fireEvent.click(view.getByText('Change 0'));
  await waitFor(() => assert.ok(view.getByText('before')));
  fireEvent.click(view.getByRole('checkbox', { name: 'Reviewed src/a.ts' }));
  await waitFor(() => assert.equal((view.getByRole('checkbox', { name: 'Reviewed src/a.ts' }) as HTMLInputElement).checked, true));
  fireEvent.click(view.getByText('b.ts')); await waitFor(() => assert.equal(ctrl.state.fileId, 'f2'));
  fireEvent.click(view.getByText('Expand ↗')); assert.ok(expanded);
  fireEvent.click(view.getByLabelText('Next commit')); await waitFor(() => assert.equal(ctrl.state.commitId, 'r:1'));
  fireEvent.click(view.getByText('← All commits')); assert.ok(view.getByLabelText('Search commits')); ctrl.dispose();
});
test('closing the SDK workspace keeps the detection control registered; expanded view stays bound', async () => {
  const routes = [route, { ...route, sessionId: 'other', storedId: 'other' }];
  host.state = { focusedSessionId: atom('chat'), focusedStoredSessionId: atom('chat'), focusedSessionOwner: atom({ connectionId: 'local', profile: 'default' }) };
  host.profileRoutes = async () => [route];
  host.requestProfile = async (_r: any, method: string) => method === 'runtime.describe' ? { capabilities: ['plugin-rpc-v1'] } : snapshot();
  const panes: any[] = []; host.openWorkspace = (id: string, options: any) => { panes.push({ id, options }); return () => options.onClose?.(); };
  const registered: string[] = []; const disposers: any[] = [];
  const ctx: any = { storage: storage(), register: (c: any) => { registered.push(c.id); return () => {}; }, registerSettingsPage() {}, onDispose: (fn: any) => disposers.push(fn), onEvent() {}, setTimeout: (fn: any) => { fn(); return () => {}; }, setInterval() {}, addEventListener() {} };
  const app = new PluginApp(ctx); app.start(); await app.focus(); await new Promise(r => setTimeout(r, 20));
  const original = app.current!; app.expand(original); panes.find(p => p.id.endsWith(':side')).options.onClose();
  assert.ok(registered.includes('commits'));
  host.state.focusedSessionId.set('other'); host.state.focusedStoredSessionId.set('other'); await app.focus();
  assert.equal(app.expanded, original); assert.notEqual(app.current, original); app.dispose(); disposers.forEach(fn => fn());
});

test('resume survives reload with comparison parent, file, context and scroll, but never crosses chat owners', async () => {
  const { ctrl, saved, rpc, snap } = fixture();
  await ctrl.refresh(); await ctrl.selectCommit('r:4', 'second-parent'); await ctrl.selectFile('f2', 20); ctrl.rememberScroll(144);
  ctrl.overview(); ctrl.dispose();
  const reopened = new ReviewController(route, rpc, saved); await reopened.refresh();
  assert.deepEqual(reopened.resumeTarget, { commitId: 'r:4', parent: 'second-parent' });
  await reopened.navigate(reopened.resumeTarget!.commitId, reopened.resumeTarget!.parent);
  assert.equal(reopened.state.parent, 'second-parent'); assert.equal(reopened.state.fileId, 'f2');
  assert.equal(reopened.state.context, 20); assert.equal(reopened.scrollTop(), 144);
  await reopened.navigate('r:4'); assert.equal(reopened.state.context, 20); assert.equal(reopened.scrollTop(), 144);
  for (const changed of [{ connectionId: 'other' }, { profile: 'other' }, { storedId: 'other' }]) {
    const other = new ReviewController({ ...route, ...changed }, rpc, saved); await other.refresh(); assert.equal(other.resumeTarget, null); other.dispose();
  }
  snap.commits = snap.commits.filter(c => c.id !== 'r:4'); await reopened.refresh();
  assert.equal(reopened.resumeTarget, null); assert.equal(reopened.state.commitId, null); reopened.dispose();
});

test('new discoveries remain quiet, survive reload, and clear only when that commit is opened', async () => {
  const { ctrl, saved, rpc, snap } = fixture(); await ctrl.refresh(); await ctrl.selectCommit('r:3');
  saved.set(`opened:${ctrl.key}`, true); assert.equal(ctrl.newCount, 0);
  snap.commits[0].occurrences++; await ctrl.refresh(); assert.equal(ctrl.newCount, 0);
  snap.commits.unshift({ ...snap.commits[0], id: 'r:new', sha: 'b'.repeat(40), subject: 'New change' });
  await ctrl.refresh(); assert.equal(ctrl.newCount, 1); assert.equal(ctrl.state.commitId, 'r:3'); assert.equal(shouldAutoOpen(ctrl, saved), false);
  const reopened = new ReviewController(route, rpc, saved); await reopened.refresh(); assert.ok(reopened.isNew('r:new'));
  await reopened.navigate('r:new'); assert.equal(reopened.newCount, 0);
  assert.equal(reopened.state.listing?.files.some(f => f.reviewed), false);
  ctrl.dispose(); reopened.dispose();
});

test('composer chips have searchable overflow, keyboard selection, reviewed labels and explicit resume', async () => {
  const { ctrl, snap } = fixture(); snap.commits[0].reviewed_count = 2;
  await ctrl.refresh(); await ctrl.selectCommit('r:2');
  const opened: any[] = [];
  const view = render(<CommitStrip ctrl={ctrl} open={(...args) => opened.push(args)}/>);
  assert.equal(view.getAllByRole('button', { name: /^Review a/ }).length, 3);
  assert.ok(view.getByRole('button', { name: /Change 0 \(reviewed\)/ }).title.includes('2 of 2 files reviewed'));
  fireEvent.click(view.getByLabelText('Resume review')); assert.deepEqual(opened.pop(), [undefined, true]);
  fireEvent.click(view.getByLabelText('Find a commit (17 more)'));
  const input = view.getByLabelText('Find a session commit');
  fireEvent.change(input, { target: { value: 'Change 17' } });
  assert.equal(view.getAllByRole('listitem').length, 1);
  fireEvent.keyDown(input, { key: 'Enter' }); assert.deepEqual(opened.pop(), ['r:17']);
  assert.equal(view.queryByRole('dialog'), null);
  fireEvent.click(view.getByLabelText('Find a commit (17 more)'));
  fireEvent.change(view.getByLabelText('Find a session commit'), { target: { value: 'repo' } });
  fireEvent.keyDown(view.getByLabelText('Find a session commit'), { key: 'ArrowDown' });
  assert.ok(document.activeElement?.textContent?.includes('Change 0'));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  await waitFor(() => assert.ok(document.activeElement?.textContent?.includes('Change 1')));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' }); assert.equal(view.queryByRole('dialog'), null);
  fireEvent.click(view.getByLabelText('Find a commit (17 more)'));
  fireEvent.change(view.getByLabelText('Find a session commit'), { target: { value: snap.commits[17].sha } });
  assert.equal(view.getAllByRole('listitem').length, 1);
  fireEvent.change(view.getByLabelText('Find a session commit'), { target: { value: 'no matches' } }); assert.ok(view.getByText('No matching commits.'));
  await act(async () => ctrl.setShowChips(false)); assert.equal(view.queryByRole('region'), null);
  assert.equal(ctrl.storage.get('showCommitChips', true), false); ctrl.dispose();
});

test('direct chip navigation leaves settings and preserves an already selected diff', async () => {
  const { ctrl, calls } = fixture(); await ctrl.refresh(); await ctrl.selectCommit('r:1');
  const view = render(<ReviewPane ctrl={ctrl} expand={() => {}}/>);
  fireEvent.click(view.getByLabelText('Plugin settings')); assert.ok(view.getByRole('switch', { name: 'Show commit chips below the composer' }));
  const requests = calls.length;
  await act(async () => ctrl.navigate('r:1'));
  assert.ok(view.getByLabelText('Selected commit')); assert.equal(calls.length, requests); ctrl.dispose();
});

test('chips reopen with auto-open off, reuse the matching expanded tab, and reject stale chat actions', async () => {
  const { saved, snap, rpc } = fixture(); snap.auto_open = false;
  host.state = { focusedSessionId: atom('chat'), focusedStoredSessionId: atom('chat'), focusedSessionOwner: atom({ connectionId: 'local', profile: 'default' }) };
  host.profileRoutes = async () => [route];
  host.requestProfile = async (r: any, method: string, params: any) => method === 'runtime.describe' ? { capabilities: ['plugin-rpc-v1'] } : rpc(r, method.split('.').slice(2).join('.'), params);
  const panes: any[] = [], revealed: string[] = [], contributions: any[] = [], disposers: any[] = [];
  host.openWorkspace = (id: string, options: any) => { panes.push({ id, options }); return () => options.onClose?.(); };
  host.revealPane = (id: string) => revealed.push(id);
  const deferred: (() => void)[] = [];
  const ctx: any = { storage: saved, register: (c: any) => { contributions.push(c); return () => {}; }, registerSettingsPage() {}, onDispose: (fn: any) => disposers.push(fn), onEvent() {}, setTimeout: (fn: () => void) => deferred.push(fn), setInterval() {}, addEventListener() {} };
  const app = new PluginApp(ctx); app.start(); await app.focus();
  const ctrl = app.current!;
  assert.equal(panes.length, 0);
  const strip = render(contributions.find(c => c.area === 'composer.underside').render());
  fireEvent.click(strip.getByLabelText('Review aaaaaaaa: Change 1')); await waitFor(() => assert.equal(ctrl.state.fileId, 'f1'));
  assert.equal(panes.length, 1); assert.equal(ctrl.state.commitId, 'r:1');
  panes[0].options.onClose();
  fireEvent.click(strip.getByLabelText('Review aaaaaaaa: Change 2')); await waitFor(() => assert.equal(ctrl.state.commitId, 'r:2'));
  assert.equal(panes.length, 2);
  await act(async () => app.expand(ctrl));
  fireEvent.click(strip.getByLabelText('Review aaaaaaaa: Change 0')); await waitFor(() => assert.equal(ctrl.state.commitId, 'r:0'));
  assert.equal(panes.length, 3); assert.ok(revealed.at(-1)?.endsWith(':expanded'));
  const command = contributions.find(c => c.area === 'palette').data; assert.equal(command.label, 'Review session commits');
  await act(async () => { ctrl.overview(); command.run(); }); assert.equal(ctrl.state.commitId, null);
  await act(async () => deferred.pop()!()); assert.equal(ctrl.state.commitId, 'r:0');
  let routeLookup!: (value: any) => void;
  host.profileRoutes = () => new Promise(resolve => { routeLookup = resolve; });
  await act(async () => { host.state.focusedStoredSessionId.set('other'); });
  assert.equal(app.current, null); assert.equal(strip.queryByRole('region'), null);
  const count = panes.length; app.openReview(ctrl, 'r:2'); assert.equal(panes.length, count); assert.equal(ctrl.state.commitId, 'r:0');
  await act(async () => { routeLookup([route]); await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.equal(app.expanded, ctrl);
  await act(async () => { app.dispose(); disposers.forEach(fn => fn()); }); delete host.revealPane;
});
