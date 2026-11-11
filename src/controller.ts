import type { RPC, Route, Storage, Snapshot, Listing, FileDiff, ReviewState } from './types';

export const ID = 'hermes-chat-git-hash-differ';
export const routeKey = (route: Route) => JSON.stringify([route.connectionId, route.profile, route.storedId]);
export function errorMessage(error: any): string {
  const detail = error?.data?.detail || error?.message || String(error);
  if (error?.code === -32601 || /method.*not found|not loaded/i.test(detail)) return 'Enable the Chat Git Hash Differ backend in this chat’s Hermes profile, then retry.';
  return detail;
}

export class ReviewController {
  state: ReviewState = { snapshot: null, commitId: null, parent: null, fileId: null, listing: null, diff: null,
    loading: false, refreshing: false, error: '', context: 3, saving: [], revision: 0, navigation: 0 };
  listeners = new Set<() => void>();
  private selection = 0;
  private reviewRevision = 0;
  private lifetime = 0;
  private refreshing = false;
  private dead = false;
  private remembered: Record<string, { file?: string; scroll?: Record<string, number>; context?: Record<string, number> }>;
  private discovery: { known: string[]; fresh: string[] } | null;
  readonly key: string;
  constructor(public route: Route, public rpc: RPC, public storage: Storage, private onSnapshot: (ctrl: ReviewController) => void = () => {}) {
    this.key = routeKey(route);
    this.remembered = storage.get(`navigation:${this.key}`, {});
    this.discovery = storage.get(`discovery:${this.key}`, null);
  }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.state;
  private set(patch: Partial<ReviewState>) {
    if (this.dead) return;
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    this.listeners.forEach(fn => fn());
  }
  updateRoute(route: Route) {
    if (route.sessionId !== this.route.sessionId) { this.lifetime++; this.selection++; }
    this.route = route;
  }
  async refresh(force = false) {
    if (this.dead || this.refreshing) return;
    this.refreshing = true;
    const life = this.lifetime;
    this.set({ refreshing: true });
    try {
      const snapshot = await this.rpc<Snapshot>(this.route, force ? 'session.refresh' : 'session.get');
      if (this.dead || life !== this.lifetime) return;
      if (!snapshot.scanning) {
        const known = new Set(this.discovery?.known);
        const fresh = new Set(this.discovery?.fresh);
        const ids = snapshot.commits.map(c => c.id);
        // The first completed backfill is a baseline; later additions stay new until opened.
        this.discovery = { known: ids, fresh: ids.filter(id => fresh.has(id) || (!!this.discovery && !known.has(id))) };
        this.storage.set(`discovery:${this.key}`, this.discovery);
      }
      this.set({ snapshot, error: '' });
      if (this.state.commitId && !snapshot.commits.some(c => c.id === this.state.commitId) && !snapshot.scanning) this.overview();
      this.onSnapshot(this);
      const { commitId, parent } = this.state;
      const selection = this.selection;
      const reviewRevision = this.reviewRevision;
      if (commitId && this.state.listing) {
        const listing = await this.rpc<Listing>(this.route, 'commit.files', { commit_id: commitId, parent });
        if (life === this.lifetime && selection === this.selection && reviewRevision === this.reviewRevision && !this.state.saving.length) this.set({ listing });
      }
    } catch (error) {
      if (life === this.lifetime) this.set({ error: errorMessage(error) });
    } finally {
      this.refreshing = false;
      this.set({ refreshing: false });
    }
  }
  overview() { this.selection++; this.set({ commitId: null, parent: null, fileId: null, listing: null, diff: null, loading: false }); }
  isNew(commitId: string) { return this.discovery?.fresh.includes(commitId) ?? false; }
  get newCount() { return this.state.snapshot?.commits.filter(c => this.isNew(c.id)).length || 0; }
  get showChips() { return this.storage.get('showCommitChips', true); }
  setShowChips(show: boolean) { this.storage.set('showCommitChips', show); this.set({}); }
  get resumeTarget(): { commitId: string; parent: string } | null {
    const last = this.storage.get<{ commitId: string; parent: string } | null>(`lastReview:${this.key}`, null);
    return last && this.state.snapshot?.commits.some(c => c.id === last.commitId) ? last : null;
  }
  async navigate(commitId: string, parent?: string) {
    if (!this.state.snapshot?.commits.some(c => c.id === commitId)) return;
    this.set({ navigation: this.state.navigation + 1 });
    // Re-fronting an active review must preserve its parent, context and scroll.
    if (this.state.commitId === commitId && (parent === undefined || parent === this.state.parent) && (this.state.listing || this.state.loading)) return;
    await this.selectCommit(commitId, parent ?? null);
  }
  async selectCommit(commitId: string, parent: string | null = null) {
    const token = ++this.selection;
    const life = this.lifetime;
    this.set({ commitId, parent, listing: null, diff: null, fileId: null, loading: true, error: '', context: 3 });
    try {
      const listing = await this.rpc<Listing>(this.route, 'commit.files', { commit_id: commitId, parent });
      if (token !== this.selection || life !== this.lifetime) return;
      const saved = this.remembered[`${commitId}:${listing.parent}`]?.file;
      const file = listing.files.find(f => f.id === saved) || listing.files.find(f => !f.reviewed) || listing.files[0];
      this.storage.set(`lastReview:${this.key}`, { commitId, parent: listing.parent });
      if (this.discovery) {
        this.discovery = { ...this.discovery, fresh: this.discovery.fresh.filter(id => id !== commitId) };
        this.storage.set(`discovery:${this.key}`, this.discovery);
      }
      this.set({ listing, parent: listing.parent, loading: false });
      if (file) await this.selectFile(file.id, this.remembered[`${commitId}:${listing.parent}`]?.context?.[file.id] ?? 3);
    } catch (error) { if (token === this.selection) this.set({ error: errorMessage(error), loading: false }); }
  }
  async selectFile(fileId: string, context = 3) {
    const { commitId, parent } = this.state;
    if (!commitId || !this.state.listing?.files.some(f => f.id === fileId)) return;
    const token = ++this.selection;
    const life = this.lifetime;
    const nav = `${commitId}:${parent}`;
    this.remembered[nav] = { ...this.remembered[nav], file: fileId, context: { ...this.remembered[nav]?.context, [fileId]: context } };
    this.storage.set(`navigation:${this.key}`, this.remembered);
    this.set({ fileId, context, diff: null, loading: true, error: '' });
    try {
      const diff = await this.rpc<FileDiff>(this.route, 'file.diff', { commit_id: commitId, parent, file_id: fileId, context });
      if (token === this.selection && life === this.lifetime) this.set({ diff, loading: false });
    } catch (error) { if (token === this.selection) this.set({ error: errorMessage(error), loading: false }); }
  }
  async review(fileId: string, reviewed: boolean) {
    const { commitId, parent } = this.state;
    if (this.state.saving.includes(fileId)) return;
    this.reviewRevision++;
    this.set({ saving: [...this.state.saving, fileId], error: '' });
    try {
      const listing = await this.rpc<Listing>(this.route, 'review.set', { commit_id: commitId, parent, file_id: fileId, reviewed });
      if (this.state.commitId === commitId && this.state.parent === parent) this.set({ listing });
      await this.refresh();
    } catch (error) { this.set({ error: errorMessage(error) }); }
    finally { this.set({ saving: this.state.saving.filter(id => id !== fileId) }); }
  }
  async addRepository(path: string, hash?: string) {
    try {
      await this.rpc(this.route, 'repositories.add', { path, ...(hash ? { hash } : {}) });
      await this.refresh();
      return true;
    } catch (error) { this.set({ error: errorMessage(error) }); return false; }
  }
  async removeRepository(repo_id: string) {
    try { await this.rpc(this.route, 'repositories.remove', { repo_id }); await this.refresh(); }
    catch (error) { this.set({ error: errorMessage(error) }); }
  }
  async autoOpen(enabled: boolean) {
    try {
      await this.rpc(this.route, 'settings.set', { auto_open: enabled });
      if (this.state.snapshot) this.set({ snapshot: { ...this.state.snapshot, auto_open: enabled } });
      this.onSnapshot(this);
    } catch (error) { this.set({ error: errorMessage(error) }); }
  }
  rememberScroll(top: number) {
    const { commitId, parent, fileId } = this.state;
    if (!commitId || !fileId) return;
    const key = `${commitId}:${parent}`;
    const item = this.remembered[key] ||= {};
    (item.scroll ||= {})[fileId] = top;
    this.storage.set(`navigation:${this.key}`, this.remembered);
  }
  scrollTop() { return this.remembered[`${this.state.commitId}:${this.state.parent}`]?.scroll?.[this.state.fileId || ''] || 0; }
  dispose() { this.dead = true; this.lifetime++; this.selection++; this.listeners.clear(); }
}

export function shouldAutoOpen(ctrl: ReviewController, storage: Storage): boolean {
  return !!ctrl.state.snapshot?.auto_open && !!ctrl.state.snapshot.commits.length && !storage.get(`opened:${ctrl.key}`, false);
}
