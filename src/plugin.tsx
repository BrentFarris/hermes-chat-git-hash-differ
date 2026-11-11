import React, { useSyncExternalStore } from 'react';
import { host, Button, STATUSBAR_AREAS, COMPOSER_AREAS, PALETTE_AREA, type PluginContext } from '@hermes/plugin-sdk';
import { ID, ReviewController, errorMessage, routeKey, shouldAutoOpen } from './controller';
import { ReviewPane, Settings, Styles } from './review';
import { CommitStrip } from './composer';
import type { Route, RPC } from './types';

export class PluginApp {
  current: ReviewController | null = null;
  expanded: ReviewController | null = null;
  status = 'Open a chat to discover its commits.';
  private controllers = new Map<string, ReviewController>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private generation = 0;
  private sideClose: (() => void) | null = null;
  private expandedClose: (() => void) | null = null;
  private capabilities = new Map<string, Promise<void>>();
  private eventPending = false;
  private disposed = false;
  constructor(private ctx: PluginContext) {}
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.revision;
  private emit() { this.revision++; this.listeners.forEach(fn => fn()); }

  rpc: RPC = async <T,>(route: Route, method: string, params: Record<string, unknown> = {}) => {
    const key = JSON.stringify([route.connectionId, route.profile]);
    if (!this.capabilities.has(key)) {
      const promise = host.requestProfile<{ capabilities: string[] }>(route, 'runtime.describe', {})
        .then(info => { if (!info.capabilities?.includes('plugin-rpc-v1')) throw new Error('Update Hermes to 0.23.1 or newer with plugin-rpc-v1 support.'); })
        .catch(error => { this.capabilities.delete(key); throw error; });
      this.capabilities.set(key, promise);
    }
    await this.capabilities.get(key);
    return host.requestProfile<T>(route, `plugin.${ID}.${method}`, { ...params, session_id: route.sessionId });
  };

  async focus() {
    const token = ++this.generation;
    const sessionId = host.state.focusedSessionId?.get();
    const storedId = host.state.focusedStoredSessionId?.get() || sessionId;
    const owner = host.state.focusedSessionOwner?.get();
    if (!storedId || !sessionId || !owner) {
      this.current = null;
      this.status = storedId ? 'Waiting for the chat’s gateway and profile…' : 'Open a chat to discover its commits.';
      this.emit(); return;
    }
    // Hide the old chat immediately, before asynchronous route lookup completes.
    if (this.current && this.current.key !== JSON.stringify([owner.connectionId, owner.profile, storedId])) {
      this.current = null; this.status = 'Loading this chat’s commits…'; this.emit();
    }
    try {
      const routes = await host.profileRoutes();
      if (token !== this.generation || this.disposed) return;
      const exact = routes.find(r => r.connectionId === owner.connectionId && r.profile === owner.profile);
      if (!exact) throw new Error('Connect to this chat’s owning gateway and profile, then retry.');
      const route = { ...exact, sessionId, storedId };
      const key = routeKey(route);
      let ctrl = this.controllers.get(key);
      if (!ctrl) {
        ctrl = new ReviewController(route, this.rpc, this.ctx.storage, controller => {
          if (controller === this.current && shouldAutoOpen(controller, this.ctx.storage)) this.openSide();
          this.emit();
        });
        ctrl.subscribe(() => this.emit());
        this.controllers.set(key, ctrl);
      } else ctrl.updateRoute(route);
      this.current = ctrl;
      this.emit();
      for (const [oldKey, old] of this.controllers) {
        if (this.controllers.size <= 12) break;
        if (old !== ctrl && old !== this.expanded) { old.dispose(); this.controllers.delete(oldKey); }
      }
      await ctrl.refresh();
    } catch (error) {
      if (token === this.generation) { this.current = null; this.status = errorMessage(error); this.emit(); }
    }
  }

  openSide() {
    if (this.current) this.ctx.storage.set(`opened:${this.current.key}`, true);
    if (this.sideClose && host.revealPane) { host.revealPane(`plugin-workspace:${ID}:side`); return; }
    // openWorkspace panes close independently, so closing never disables the detector plugin.
    this.sideClose = host.openWorkspace(`${ID}:side`, { title: 'Session commits', minWidth: '24rem',
      dock: { pane: 'workspace', pos: 'right' }, render: () => <Side app={this}/>, onClose: () => { this.sideClose = null; } });
  }
  openReview(ctrl: ReviewController, commitId?: string, resume = false) {
    const owner = host.state.focusedSessionOwner?.get();
    const storedId = host.state.focusedStoredSessionId?.get() || host.state.focusedSessionId?.get();
    // A picker may have been open during a navigation. Never act on its stale chat.
    if (ctrl !== this.current || !owner || ctrl.key !== JSON.stringify([owner.connectionId, owner.profile, storedId])) return;
    if (commitId && !ctrl.state.snapshot?.commits.some(c => c.id === commitId)) return;
    const target = resume ? ctrl.resumeTarget : null;
    if (commitId || target) void ctrl.navigate(commitId || target!.commitId, target?.parent);
    this.ctx.storage.set(`opened:${ctrl.key}`, true);
    if (this.expanded === ctrl && this.expandedClose) {
      if (host.revealPane) host.revealPane(`plugin-workspace:${ID}:expanded`);
      else this.expand(ctrl);
    } else this.openSide();
  }
  expand(ctrl: ReviewController) {
    this.sideClose?.();
    this.sideClose = null;
    this.expanded = ctrl;
    this.expandedClose = host.openWorkspace(`${ID}:expanded`, { title: 'Commit review', minWidth: '30rem',
      render: () => <ReviewPane ctrl={ctrl} expanded expand={() => {}}/>,
      onClose: () => { this.expanded = null; this.expandedClose = null; } });
  }
  poll() {
    if (this.disposed || document.hidden) return;
    void this.current?.refresh();
    if (this.expanded && this.expanded !== this.current && host.paneVisibility(`plugin-workspace:${ID}:expanded`).get()) void this.expanded.refresh();
  }
  start() {
    if (typeof host.openWorkspace !== 'function' || typeof host.profileRoutes !== 'function' || typeof host.requestProfile !== 'function' || typeof host.paneVisibility !== 'function' || !host.state.focusedSessionOwner || typeof this.ctx.registerSettingsPage !== 'function') {
      this.status = 'Update Hermes to 0.23.1 with the Desktop workspace and session-owner APIs.';
      this.ctx.register({ id: 'unavailable', area: STATUSBAR_AREAS.right, render: () => <span title={this.status}>Commit review unavailable</span> });
      return;
    }
    this.ctx.register({ id: 'commits', area: STATUSBAR_AREAS.right, render: () => <Badge app={this}/> });
    if (COMPOSER_AREAS?.underside) this.ctx.register({ id: 'commit-chips', area: COMPOSER_AREAS.underside, render: () => <Composer app={this}/> });
    if (PALETTE_AREA) this.ctx.register({ id: 'review-session-commits', area: PALETTE_AREA, data: {
      id: `${ID}:review-session-commits`, label: 'Review session commits', keywords: ['git', 'hash', 'diff', 'resume'],
      detail: () => `${this.current?.state.snapshot?.commits.length || 0} commits in the focused chat`,
      run: () => {
        const ctrl = this.current;
        // Let the native palette release its focus trap before fronting a workspace.
        this.ctx.setTimeout(() => { if (ctrl) this.openReview(ctrl, undefined, true); else if (!this.current) this.openSide(); }, 0);
      },
    } });
    this.ctx.registerSettingsPage({ id: 'review', title: 'Chat Git Hash Differ', render: () => <SettingsPage app={this}/> });
    for (const key of ['focusedSessionId', 'focusedStoredSessionId', 'focusedSessionOwner', 'connectionId', 'gateway']) {
      if (host.state[key]) this.ctx.onDispose(host.state[key].subscribe(() => { void this.focus(); }));
    }
    this.ctx.onEvent('*', event => {
      const type = String(event?.type || '');
      if (!/^(session\.|chat\.|agent\.|tool\.|plugin\.hermes-chat-git-hash-differ\.)/.test(type) || this.eventPending) return;
      this.eventPending = true;
      this.ctx.setTimeout(() => { this.eventPending = false; this.poll(); }, 250);
    });
    this.ctx.setInterval(() => this.poll(), 5000);
    this.ctx.addEventListener(document, 'visibilitychange', () => { if (!document.hidden) { void this.focus(); } });
    this.ctx.onDispose(() => this.dispose());
    void this.focus();
  }
  dispose() {
    this.disposed = true; this.generation++;
    this.sideClose?.(); this.expandedClose?.();
    for (const ctrl of this.controllers.values()) ctrl.dispose();
    this.controllers.clear(); this.listeners.clear();
  }
}

function Badge({ app }: { app: PluginApp }) {
  useSyncExternalStore(app.subscribe, app.getSnapshot);
  const state = app.current?.state;
  return <span className="hgd"><Styles/><Button variant="ghost" size="xs" style={{ fontSize: 11, lineHeight: '16px' }} title={state?.error || 'Review commits mentioned in this chat'} onClick={() => app.current ? app.openReview(app.current) : app.openSide()}>
    Commits · {state?.snapshot?.commits.length || 0}{state?.snapshot?.scanning ? ' …' : state?.error ? ' !' : ''}
  </Button></span>;
}
function Composer({ app }: { app: PluginApp }) {
  useSyncExternalStore(app.subscribe, app.getSnapshot);
  const ctrl = app.current;
  // Render slots are global in SDK 0.23.1. Explicitly follow the focused chat,
  // using the same owner/profile fence as the persistent status-bar control.
  return ctrl?.showChips && ctrl.state.snapshot?.commits.length ? <CommitStrip key={ctrl.key} ctrl={ctrl}
    open={(commitId, resume) => app.openReview(ctrl, commitId, resume)}/> : null;
}
function Side({ app }: { app: PluginApp }) {
  useSyncExternalStore(app.subscribe, app.getSnapshot);
  return app.current ? <ReviewPane key={app.current.key} ctrl={app.current} expand={() => app.expand(app.current!)}/> : <div className="hgd hgd-empty"><Styles/>{app.status}<p><Button onClick={() => void app.focus()}>Retry</Button></p></div>;
}
function SettingsPage({ app }: { app: PluginApp }) {
  useSyncExternalStore(app.subscribe, app.getSnapshot);
  return app.current ? <Settings ctrl={app.current}/> : <div className="hgd hgd-empty"><Styles/>Open a chat to configure its profile’s commit review settings.</div>;
}

export default { id: ID, name: 'Chat Git Hash Differ', version: '0.2.0', defaultEnabled: false,
  register(ctx: PluginContext) { new PluginApp(ctx).start(); } };
