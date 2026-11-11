import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { JSDOM } from 'jsdom';
import { render, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { ReviewController, shouldAutoOpen } from '../src/controller';
import { ReviewPane, VirtualList, diffRows } from '../src/review';
import { PluginApp } from '../src/plugin';
import { host, atom } from './sdk-fixture';
import type { Snapshot, Listing, Route } from '../src/types';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { constructor(private fn: any) {} observe() { this.fn([{ contentRect: { width: 1200 } }]); } disconnect() {} } });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
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
    if (method === 'commit.files' || method === 'review.set') return structuredClone(list);
    return diff;
  };
  return { ctrl: new ReviewController(route, rpc, saved), rpc, saved, calls };
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
