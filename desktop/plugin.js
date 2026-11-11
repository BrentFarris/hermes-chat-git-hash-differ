// src/plugin.tsx
import { useSyncExternalStore as useSyncExternalStore2 } from "react";
import { host, Button as Button3, STATUSBAR_AREAS, COMPOSER_AREAS, PALETTE_AREA } from "@hermes/plugin-sdk";

// src/controller.ts
var ID = "hermes-chat-git-hash-differ";
var routeKey = (route) => JSON.stringify([route.connectionId, route.profile, route.storedId]);
function errorMessage(error) {
  const detail = error?.data?.detail || error?.message || String(error);
  if (error?.code === -32601 || /method.*not found|not loaded/i.test(detail)) return "Enable the Chat Git Hash Differ backend in this chat’s Hermes profile, then retry.";
  return detail;
}
var ReviewController = class {
  constructor(route, rpc, storage, onSnapshot = () => {
  }) {
    this.route = route;
    this.rpc = rpc;
    this.storage = storage;
    this.onSnapshot = onSnapshot;
    this.key = routeKey(route);
    this.remembered = storage.get(`navigation:${this.key}`, {});
    this.discovery = storage.get(`discovery:${this.key}`, null);
  }
  state = {
    snapshot: null,
    commitId: null,
    parent: null,
    fileId: null,
    listing: null,
    diff: null,
    loading: false,
    refreshing: false,
    error: "",
    context: 3,
    saving: [],
    revision: 0,
    navigation: 0
  };
  listeners = /* @__PURE__ */ new Set();
  selection = 0;
  reviewRevision = 0;
  lifetime = 0;
  refreshing = false;
  dead = false;
  remembered;
  discovery;
  key;
  subscribe = (fn) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.state;
  set(patch) {
    if (this.dead) return;
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    this.listeners.forEach((fn) => fn());
  }
  updateRoute(route) {
    if (route.sessionId !== this.route.sessionId) {
      this.lifetime++;
      this.selection++;
    }
    this.route = route;
  }
  async refresh(force = false) {
    if (this.dead || this.refreshing) return;
    this.refreshing = true;
    const life = this.lifetime;
    this.set({ refreshing: true });
    try {
      const snapshot = await this.rpc(this.route, force ? "session.refresh" : "session.get");
      if (this.dead || life !== this.lifetime) return;
      if (!snapshot.scanning) {
        const known = new Set(this.discovery?.known);
        const fresh = new Set(this.discovery?.fresh);
        const ids = snapshot.commits.map((c) => c.id);
        this.discovery = { known: ids, fresh: ids.filter((id) => fresh.has(id) || !!this.discovery && !known.has(id)) };
        this.storage.set(`discovery:${this.key}`, this.discovery);
      }
      this.set({ snapshot, error: "" });
      if (this.state.commitId && !snapshot.commits.some((c) => c.id === this.state.commitId) && !snapshot.scanning) this.overview();
      this.onSnapshot(this);
      const { commitId, parent } = this.state;
      const selection = this.selection;
      const reviewRevision = this.reviewRevision;
      if (commitId && this.state.listing) {
        const listing = await this.rpc(this.route, "commit.files", { commit_id: commitId, parent });
        if (life === this.lifetime && selection === this.selection && reviewRevision === this.reviewRevision && !this.state.saving.length) this.set({ listing });
      }
    } catch (error) {
      if (life === this.lifetime) this.set({ error: errorMessage(error) });
    } finally {
      this.refreshing = false;
      this.set({ refreshing: false });
    }
  }
  overview() {
    this.selection++;
    this.set({ commitId: null, parent: null, fileId: null, listing: null, diff: null, loading: false });
  }
  isNew(commitId) {
    return this.discovery?.fresh.includes(commitId) ?? false;
  }
  get newCount() {
    return this.state.snapshot?.commits.filter((c) => this.isNew(c.id)).length || 0;
  }
  get showChips() {
    return this.storage.get("showCommitChips", true);
  }
  setShowChips(show) {
    this.storage.set("showCommitChips", show);
    this.set({});
  }
  get resumeTarget() {
    const last = this.storage.get(`lastReview:${this.key}`, null);
    return last && this.state.snapshot?.commits.some((c) => c.id === last.commitId) ? last : null;
  }
  async navigate(commitId, parent) {
    if (!this.state.snapshot?.commits.some((c) => c.id === commitId)) return;
    this.set({ navigation: this.state.navigation + 1 });
    if (this.state.commitId === commitId && (parent === void 0 || parent === this.state.parent) && (this.state.listing || this.state.loading)) return;
    await this.selectCommit(commitId, parent ?? null);
  }
  async selectCommit(commitId, parent = null) {
    const token = ++this.selection;
    const life = this.lifetime;
    this.set({ commitId, parent, listing: null, diff: null, fileId: null, loading: true, error: "", context: 3 });
    try {
      const listing = await this.rpc(this.route, "commit.files", { commit_id: commitId, parent });
      if (token !== this.selection || life !== this.lifetime) return;
      const saved = this.remembered[`${commitId}:${listing.parent}`]?.file;
      const file = listing.files.find((f) => f.id === saved) || listing.files.find((f) => !f.reviewed) || listing.files[0];
      this.storage.set(`lastReview:${this.key}`, { commitId, parent: listing.parent });
      if (this.discovery) {
        this.discovery = { ...this.discovery, fresh: this.discovery.fresh.filter((id) => id !== commitId) };
        this.storage.set(`discovery:${this.key}`, this.discovery);
      }
      this.set({ listing, parent: listing.parent, loading: false });
      if (file) await this.selectFile(file.id, this.remembered[`${commitId}:${listing.parent}`]?.context?.[file.id] ?? 3);
    } catch (error) {
      if (token === this.selection) this.set({ error: errorMessage(error), loading: false });
    }
  }
  async selectFile(fileId, context = 3) {
    const { commitId, parent } = this.state;
    if (!commitId || !this.state.listing?.files.some((f) => f.id === fileId)) return;
    const token = ++this.selection;
    const life = this.lifetime;
    const nav = `${commitId}:${parent}`;
    this.remembered[nav] = { ...this.remembered[nav], file: fileId, context: { ...this.remembered[nav]?.context, [fileId]: context } };
    this.storage.set(`navigation:${this.key}`, this.remembered);
    this.set({ fileId, context, diff: null, loading: true, error: "" });
    try {
      const diff = await this.rpc(this.route, "file.diff", { commit_id: commitId, parent, file_id: fileId, context });
      if (token === this.selection && life === this.lifetime) this.set({ diff, loading: false });
    } catch (error) {
      if (token === this.selection) this.set({ error: errorMessage(error), loading: false });
    }
  }
  async review(fileId, reviewed) {
    const { commitId, parent } = this.state;
    if (this.state.saving.includes(fileId)) return;
    this.reviewRevision++;
    this.set({ saving: [...this.state.saving, fileId], error: "" });
    try {
      const listing = await this.rpc(this.route, "review.set", { commit_id: commitId, parent, file_id: fileId, reviewed });
      if (this.state.commitId === commitId && this.state.parent === parent) this.set({ listing });
      await this.refresh();
    } catch (error) {
      this.set({ error: errorMessage(error) });
    } finally {
      this.set({ saving: this.state.saving.filter((id) => id !== fileId) });
    }
  }
  async addRepository(path, hash) {
    try {
      await this.rpc(this.route, "repositories.add", { path, ...hash ? { hash } : {} });
      await this.refresh();
      return true;
    } catch (error) {
      this.set({ error: errorMessage(error) });
      return false;
    }
  }
  async removeRepository(repo_id) {
    try {
      await this.rpc(this.route, "repositories.remove", { repo_id });
      await this.refresh();
    } catch (error) {
      this.set({ error: errorMessage(error) });
    }
  }
  async autoOpen(enabled) {
    try {
      await this.rpc(this.route, "settings.set", { auto_open: enabled });
      if (this.state.snapshot) this.set({ snapshot: { ...this.state.snapshot, auto_open: enabled } });
      this.onSnapshot(this);
    } catch (error) {
      this.set({ error: errorMessage(error) });
    }
  }
  rememberScroll(top) {
    const { commitId, parent, fileId } = this.state;
    if (!commitId || !fileId) return;
    const key = `${commitId}:${parent}`;
    const item = this.remembered[key] ||= {};
    (item.scroll ||= {})[fileId] = top;
    this.storage.set(`navigation:${this.key}`, this.remembered);
  }
  scrollTop() {
    return this.remembered[`${this.state.commitId}:${this.state.parent}`]?.scroll?.[this.state.fileId || ""] || 0;
  }
  dispose() {
    this.dead = true;
    this.lifetime++;
    this.selection++;
    this.listeners.clear();
  }
};
function shouldAutoOpen(ctrl, storage) {
  return !!ctrl.state.snapshot?.auto_open && !!ctrl.state.snapshot.commits.length && !storage.get(`opened:${ctrl.key}`, false);
}

// src/review.tsx
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button as NativeButton, Input, Switch } from "@hermes/plugin-sdk";

// src/styles.css
var styles_default = ".hgd { --hgd-muted: var(--ui-text-secondary, #9299a7); --hgd-line: var(--ui-stroke-tertiary, #303640); --hgd-accent: var(--ui-accent, #6ea9fa); font: 13px/1.5 system-ui,sans-serif; color:var(--ui-text-primary,inherit); min-width:0; }\n.hgd * { box-sizing:border-box; }\n.hgd-pane { height:100%; display:flex; flex-direction:column; overflow:hidden; position:relative; }\n.hgd button,.hgd input,.hgd select { font:inherit; }\n.hgd button { cursor:pointer; }\n.hgd button:disabled { opacity:.45; cursor:default; }\n.hgd button:focus-visible,.hgd input:focus-visible,.hgd select:focus-visible { outline:2px solid var(--hgd-accent); outline-offset:2px; }\n.hgd select { color:inherit; background:var(--ui-bg-base, Canvas); border:1px solid var(--hgd-line); border-radius:6px; padding:6px; max-width:100%; }\n.hgd input[type=checkbox] { accent-color:var(--hgd-accent); flex:none; width:15px; height:15px; }\n.hgd input:not([type=checkbox]) { width:100%; }\n.hgd-header { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:12px; border-bottom:1px solid var(--hgd-line); flex:none; }\n.hgd-header>div,.hgd-actions,.hgd-row { display:flex; align-items:center; gap:8px; min-width:0; }\n.hgd-count { border:1px solid var(--hgd-line); border-radius:12px; padding:0 7px; }\n.hgd-grow { flex:1; }\n.hgd-muted { color:var(--hgd-muted); font-size:12px; }\n.hgd-padded { padding:10px 12px; }\n.hgd-scan { font-size:11px; color:var(--hgd-muted); padding:4px 12px; }\n.hgd-empty { padding:24px 16px; text-align:center; color:var(--hgd-muted); }\n.hgd-empty strong { color:var(--ui-text-primary,inherit); }\n.hgd-empty p { max-width:36em; margin:10px auto; }\n.hgd-error { border-left:3px solid #e1a657; padding:9px 12px; overflow-wrap:anywhere; }\n.hgd-error button { margin-left:10px; }\n.hgd-details { border-top:1px solid var(--hgd-line); padding:8px 12px; flex:none; }\n.hgd summary { cursor:pointer; }\n.hgd-repo { display:flex; gap:8px; align-items:center; justify-content:space-between; padding:7px 0; }\n.hgd-repo span { overflow-wrap:anywhere; min-width:0; }\n.hgd-repo small { display:block; color:var(--hgd-muted); }\n.hgd-unresolved { max-height:190px; overflow:auto; }\n.hgd-virtual { height:100%; min-height:0; overflow:auto; flex:1; overscroll-behavior:contain; }\n.hgd-commit-list { flex:1; min-height:130px; display:flex; flex-direction:column; }\n.hgd-commit { padding:10px 12px; width:100%; height:100%; border:0; border-bottom:1px solid var(--hgd-line); background:transparent; color:inherit; text-align:left; }\n.hgd-commit:hover,.hgd-file-row:hover { background:color-mix(in srgb,var(--hgd-accent) 7%,transparent); }\n.hgd-commit strong { display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin:4px 0; }\n.hgd-commit .hgd-row { overflow:hidden; white-space:nowrap; }\n.hgd-progress { margin-left:auto; font-size:11px; color:var(--hgd-muted); }\n.hgd-selection { padding:8px 12px; display:flex; flex-direction:column; gap:7px; border-bottom:1px solid var(--hgd-line); flex:none; }\n.hgd-selection>select { width:100%; }\n.hgd-full-sha { word-break:break-all; }\n.hgd-review-body { display:flex; flex-direction:column; flex:1; min-height:0; }\n.hgd-file-section { display:flex; flex-direction:column; height:min(220px,35%); min-height:33px; flex-shrink:0; border-bottom:1px solid var(--hgd-line); }\n.hgd-file-section.hgd-collapsed { height:33px; }\n.hgd-files-toggle { border:0; background:transparent; color:inherit; text-align:left; padding:7px 12px; }\n.hgd-files { display:flex; flex-direction:column; flex:1; min-height:0; padding:0 8px 5px; }\n.hgd-filter { font-size:12px; display:flex; gap:5px; align-items:center; padding:5px 0; }\n.hgd-directory { color:var(--hgd-muted); font-size:11px; line-height:38px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }\n.hgd-file-row { display:flex; align-items:center; height:38px; gap:6px; border-radius:4px; }\n.hgd-selected { background:color-mix(in srgb,var(--hgd-accent) 14%,transparent); }\n.hgd-file-row>button { border:0; background:transparent; color:inherit; flex:1; min-width:0; display:flex; align-items:center; gap:6px; padding:6px 3px; text-align:left; }\n.hgd-filename { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }\n.hgd-status { font:11px ui-monospace,monospace; color:var(--hgd-muted); }\n.hgd-file-row small { font-size:10px; white-space:nowrap; color:var(--hgd-muted); }\n.hgd-diff { display:flex; flex-direction:column; min-height:150px; min-width:0; flex:1; }\n.hgd-diff-header { display:flex; align-items:center; gap:10px; padding:8px 12px; border-bottom:1px solid var(--hgd-line); }\n.hgd-diff-header strong { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }\n.hgd-diff-header label { white-space:nowrap; display:flex; align-items:center; gap:4px; font-size:12px; }\n.hgd-toolbar { display:flex; align-items:center; gap:9px; padding:5px 12px; flex-wrap:wrap; }\n.hgd-notice { padding:12px; color:var(--hgd-muted); }\n.hgd-line { display:flex; height:24px; line-height:24px; min-width:max-content; font:12px/24px ui-monospace,SFMono-Regular,Consolas,monospace; }\n.hgd-number { width:46px; flex:none; text-align:right; padding-right:8px; color:var(--hgd-muted); user-select:none; }\n.hgd-sign { width:20px; text-align:center; flex:none; user-select:none; }\n.hgd-line code { white-space:pre; padding-right:16px; tab-size:4; }\n.hgd-add { background:color-mix(in srgb,#38ad77 15%,transparent); }\n.hgd-add .hgd-sign { color:#42b883; }\n.hgd-delete { background:color-mix(in srgb,#e16d76 15%,transparent); }\n.hgd-delete .hgd-sign { color:#e78991; }\n.hgd-note { color:var(--hgd-muted); font-style:italic; }\n.hgd-hunk { background:color-mix(in srgb,var(--hgd-accent) 10%,transparent); color:var(--hgd-muted); font:11px/24px ui-monospace,monospace; padding-left:12px; white-space:pre; min-width:max-content; }\n.hgd-split { display:grid; grid-template-columns:1fr 1fr; height:24px; }\n.hgd-split .hgd-line { min-width:0; overflow:hidden; }\n.hgd-split .hgd-line:first-child { border-right:1px solid var(--hgd-line); }\n.hgd-expanded .hgd-review-body { flex-direction:row; }\n.hgd-expanded .hgd-file-section { width:270px; height:auto; border-right:1px solid var(--hgd-line); border-bottom:0; }\n.hgd-expanded .hgd-file-section.hgd-collapsed { width:90px; }\n.hgd-settings { padding:20px; overflow:auto; }\n.hgd-settings h2 { font-size:16px; margin-top:0; }\n.hgd-setting { display:flex; align-items:center; gap:20px; }\n.hgd-setting>div { flex:1; }\n.hgd-settings p { color:var(--hgd-muted); }\n.hgd-dialog-backdrop { position:absolute; inset:0; background:#0007; z-index:10; display:flex; align-items:center; justify-content:center; padding:16px; }\n.hgd-dialog { width:100%; max-width:460px; padding:20px; border:1px solid var(--hgd-line); border-radius:10px; background:var(--ui-bg-base,Canvas); box-shadow:0 12px 40px #0004; }\n.hgd-dialog h3 { margin:0 0 10px; }\n.hgd-dialog .hgd-actions { justify-content:flex-end; margin-top:12px; }\n.hgd-commit-strip { display:flex; align-items:center; gap:6px; width:100%; min-width:0; padding:1px 0; }\n.hgd .hgd-chip { display:inline-flex; align-items:center; gap:5px; height:27px; min-height:27px; padding:3px 8px; border:1px solid var(--hgd-line); border-radius:14px; background:var(--composer-fill,var(--ui-bg-base,Canvas)); color:var(--hgd-muted); white-space:nowrap; font-size:11px; font-weight:400; flex-shrink:0; }\n.hgd .hgd-chip:hover { background:var(--chrome-action-hover,color-mix(in srgb,var(--hgd-accent) 12%,transparent)); color:var(--ui-text-primary,inherit); }\n.hgd .hgd-hash-chip { flex-shrink:1; min-width:0; max-width:162px; }\n.hgd-chip code { font:11px ui-monospace,monospace; }\n.hgd-chip-subject { overflow:hidden; text-overflow:ellipsis; min-width:0; }\n.hgd-new { font-size:10px; color:var(--hgd-accent); }\n.hgd .hgd-resume { margin-left:auto; }\n.hgd-commit-picker { width:min(420px,calc(100vw - 24px)); max-height:var(--radix-popover-content-available-height,480px); display:flex; flex-direction:column; gap:8px; padding:12px; overflow:hidden; }\n.hgd-picker-heading { display:flex; justify-content:space-between; gap:8px; }\n.hgd-picker-chat { margin:0; font-size:11px; color:var(--hgd-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }\n.hgd-picker-results { display:flex; flex-direction:column; height:280px; min-height:70px; overflow:hidden; }\n.hgd-picker-result { width:100%; height:100%; border:0; border-radius:5px; padding:6px 8px; background:transparent; text-align:left; color:inherit; }\n.hgd-picker-result:hover { background:color-mix(in srgb,var(--hgd-accent) 9%,transparent); }\n.hgd-picker-result strong,.hgd-picker-result small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }\n.hgd-picker-result small,.hgd-picker-result .hgd-row { color:var(--hgd-muted); font-size:11px; }\n@media(max-width:750px) { .hgd-expanded .hgd-review-body { flex-direction:column; } .hgd-expanded .hgd-file-section { width:auto; height:210px; } .hgd-expanded .hgd-file-section.hgd-collapsed { width:auto; height:33px; } }\n";

// src/review.tsx
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
var Button = (props) => /* @__PURE__ */ jsx(NativeButton, { size: "sm", variant: "secondary", ...props });
var Styles = () => /* @__PURE__ */ jsx("style", { children: styles_default });
var useReview = (ctrl) => useSyncExternalStore(ctrl.subscribe, ctrl.getSnapshot);
function VirtualList({ items, height = 44, label, render, active = -1, initialScroll = 0, onScroll, focusable = () => true }) {
  const ref = useRef(null);
  const [view, setView] = useState({ top: initialScroll, height: 400 });
  useLayoutEffect(() => {
    const el = ref.current;
    el.scrollTop = initialScroll;
    const resize = () => setView({ top: el.scrollTop, height: el.clientHeight || 400 });
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || active < 0) return;
    if (active * height < el.scrollTop) el.scrollTop = active * height;
    else if ((active + 1) * height > el.scrollTop + el.clientHeight) el.scrollTop = (active + 1) * height - el.clientHeight;
  }, [active, height]);
  const start = Math.max(0, Math.floor(view.top / height) - 8);
  const end = Math.min(items.length, Math.ceil((view.top + view.height) / height) + 8);
  return /* @__PURE__ */ jsx(
    "div",
    {
      className: "hgd-virtual",
      ref,
      role: "list",
      "aria-label": label,
      onScroll: (e) => {
        const top = e.currentTarget.scrollTop;
        setView((v) => ({ ...v, top }));
        onScroll?.(top);
      },
      onKeyDown: (e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        const index = Number(e.target.closest("[data-row]")?.getAttribute("data-row"));
        if (!Number.isFinite(index)) return;
        const step = e.key === "ArrowDown" ? 1 : -1;
        let next = index + step;
        while (next >= 0 && next < items.length && !focusable(items[next])) next += step;
        if (next < 0 || next >= items.length) return;
        e.preventDefault();
        ref.current.scrollTop = Math.max(0, next * height - view.height / 2);
        requestAnimationFrame(() => ref.current?.querySelector(`[data-row="${next}"] button`)?.focus());
      },
      children: /* @__PURE__ */ jsx("div", { style: { height: items.length * height, position: "relative", minWidth: "100%" }, children: items.slice(start, end).map((item, n) => /* @__PURE__ */ jsx(
        "div",
        {
          role: "listitem",
          "data-row": start + n,
          style: { position: "absolute", top: (start + n) * height, height, width: "100%" },
          children: render(item, start + n)
        },
        start + n
      )) })
    }
  );
}
function Settings({ ctrl }) {
  const state = useReview(ctrl);
  const id = useId();
  return /* @__PURE__ */ jsxs("div", { className: "hgd hgd-settings", children: [
    /* @__PURE__ */ jsx(Styles, {}),
    /* @__PURE__ */ jsx("h2", { children: "Chat Git Hash Differ" }),
    /* @__PURE__ */ jsxs("div", { className: "hgd-setting", children: [
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("label", { htmlFor: `${id}-auto-open`, children: "Automatically open the commit panel" }),
        /* @__PURE__ */ jsx("p", { children: "Open once per chat when a valid commit is found. Later discoveries leave your review in place." })
      ] }),
      /* @__PURE__ */ jsx(Switch, { id: `${id}-auto-open`, checked: state.snapshot?.auto_open ?? true, onCheckedChange: (value) => void ctrl.autoOpen(value) })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "hgd-setting", children: [
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("label", { htmlFor: `${id}-chips`, children: "Show commit chips below the composer" }),
        /* @__PURE__ */ jsx("p", { children: "Quick access to the focused chat’s commits, even when review is closed. Saved on this client." })
      ] }),
      /* @__PURE__ */ jsx(Switch, { id: `${id}-chips`, checked: ctrl.showChips, onCheckedChange: (value) => ctrl.setShowChips(value) })
    ] }),
    /* @__PURE__ */ jsx("p", { children: "Repository paths refer to the machine running this chat’s Hermes backend. Review progress is shared with its Webapp." }),
    state.error && /* @__PURE__ */ jsx("p", { role: "alert", children: state.error })
  ] });
}
function RepositoryDialog({ ctrl, hash, close }) {
  const state = useReview(ctrl);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const save = async (value) => {
    setBusy(true);
    if (await ctrl.addRepository(value, hash)) close();
    setBusy(false);
  };
  return /* @__PURE__ */ jsx("div", { className: "hgd-dialog-backdrop", onKeyDown: (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Tab") {
      const nodes = Array.from(e.currentTarget.querySelectorAll("button:not(:disabled), input, select"));
      if (e.shiftKey && document.activeElement === nodes[0]) {
        e.preventDefault();
        nodes.at(-1)?.focus();
      }
      if (!e.shiftKey && document.activeElement === nodes.at(-1)) {
        e.preventDefault();
        nodes[0]?.focus();
      }
    }
  }, children: /* @__PURE__ */ jsxs("div", { className: "hgd-dialog", role: "dialog", "aria-modal": "true", "aria-label": hash ? `Resolve ${hash}` : "Add repository", children: [
    /* @__PURE__ */ jsx("h3", { children: hash ? `Choose repository for ${hash}` : "Add repository" }),
    /* @__PURE__ */ jsx("p", { children: "Enter a repository directory on the Hermes host." }),
    hash && state.snapshot?.repositories.map((repo) => /* @__PURE__ */ jsx(Button, { disabled: busy, onClick: () => void save(repo.path), children: repo.name }, repo.id)),
    /* @__PURE__ */ jsxs("form", { onSubmit: (e) => {
      e.preventDefault();
      if (path.trim()) void save(path.trim());
    }, children: [
      /* @__PURE__ */ jsx(Input, { ref: input, "aria-label": "Repository path on Hermes host", value: path, onChange: (e) => setPath(e.target.value), placeholder: "C:\\Projects\\my-repository or /srv/project" }),
      state.error && /* @__PURE__ */ jsx("p", { role: "alert", children: state.error }),
      /* @__PURE__ */ jsxs("div", { className: "hgd-actions", children: [
        /* @__PURE__ */ jsx(Button, { type: "button", onClick: close, children: "Cancel" }),
        /* @__PURE__ */ jsx(Button, { type: "submit", disabled: busy || !path.trim(), children: busy ? "Checking…" : "Use repository" })
      ] })
    ] })
  ] }) });
}
function Repositories({ ctrl, choose }) {
  const state = useReview(ctrl);
  return /* @__PURE__ */ jsxs("details", { className: "hgd-details", children: [
    /* @__PURE__ */ jsxs("summary", { children: [
      "Repositories · ",
      state.snapshot?.repositories.length || 0
    ] }),
    state.snapshot?.repositories.map((repo) => /* @__PURE__ */ jsxs("div", { className: "hgd-repo", children: [
      /* @__PURE__ */ jsx("span", { title: repo.path, children: repo.path }),
      /* @__PURE__ */ jsx(Button, { "aria-label": `Remove repository ${repo.name}`, onClick: () => void ctrl.removeRepository(repo.id), children: "Remove" })
    ] }, repo.id)),
    /* @__PURE__ */ jsx(Button, { onClick: () => choose(), children: "Add repository" })
  ] });
}
function CommitOverview({ ctrl, choose }) {
  const state = useReview(ctrl);
  const [search, setSearch] = useState("");
  const commits = (state.snapshot?.commits || []).filter((c) => `${c.subject} ${c.sha} ${c.repo_name}`.toLowerCase().includes(search.toLowerCase()));
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("div", { className: "hgd-padded", children: /* @__PURE__ */ jsx(Input, { "aria-label": "Search commits", placeholder: "Find a commit or repository…", value: search, onChange: (e) => setSearch(e.target.value) }) }),
    /* @__PURE__ */ jsxs("div", { className: "hgd-commit-list", children: [
      !commits.length && /* @__PURE__ */ jsxs("div", { className: "hgd-empty", children: [
        /* @__PURE__ */ jsx("strong", { children: state.snapshot?.scanning ? "Looking for commits…" : "No matching commits" }),
        /* @__PURE__ */ jsx("p", { children: "Hashes mentioned in messages and tool output will appear here. Add a repository if it is outside the chat’s working folder." }),
        /* @__PURE__ */ jsx(Button, { onClick: () => choose(), children: "Add repository" })
      ] }),
      /* @__PURE__ */ jsx(VirtualList, { items: commits, height: 94, label: "Detected commits", render: (commit) => /* @__PURE__ */ jsxs("button", { className: "hgd-commit", onClick: () => void ctrl.selectCommit(commit.id), children: [
        /* @__PURE__ */ jsxs("div", { className: "hgd-row", children: [
          /* @__PURE__ */ jsx("code", { children: commit.sha.slice(0, 8) }),
          /* @__PURE__ */ jsx("span", { className: "hgd-muted", children: commit.repo_name }),
          /* @__PURE__ */ jsx("span", { className: "hgd-progress", children: commit.file_count !== null && commit.reviewed_count === commit.file_count ? "✓ Reviewed" : `${commit.reviewed_count || 0}/${commit.file_count ?? "—"} reviewed` })
        ] }),
        /* @__PURE__ */ jsx("strong", { title: commit.subject, children: commit.subject }),
        /* @__PURE__ */ jsxs("div", { className: "hgd-row hgd-muted", children: [
          /* @__PURE__ */ jsxs("span", { children: [
            commit.file_count ?? "—",
            " files"
          ] }),
          /* @__PURE__ */ jsxs("span", { children: [
            commit.occurrences,
            " ",
            commit.occurrences === 1 ? "mention" : "mentions"
          ] }),
          commit.problem && /* @__PURE__ */ jsxs("span", { children: [
            "⚠ ",
            commit.problem.message
          ] })
        ] })
      ] }) })
    ] }),
    !!state.snapshot?.unresolved.length && /* @__PURE__ */ jsxs("details", { className: "hgd-details", children: [
      /* @__PURE__ */ jsxs("summary", { children: [
        "Unresolved references · ",
        state.snapshot.unresolved.length
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "hgd-unresolved", children: [
        state.snapshot.unresolved.map((ref, n) => /* @__PURE__ */ jsxs("div", { className: "hgd-repo", children: [
          /* @__PURE__ */ jsxs("span", { children: [
            /* @__PURE__ */ jsx("code", { children: ref.hash }),
            /* @__PURE__ */ jsx("small", { children: ref.reason === "ambiguous" ? "Choose a matching repository or use a longer hash" : "Not available in linked repositories" })
          ] }),
          /* @__PURE__ */ jsx(Button, { onClick: () => choose(ref.hash), children: "Choose repository" })
        ] }, `${ref.hash}:${n}`)),
        /* @__PURE__ */ jsx(Button, { onClick: () => void ctrl.refresh(true), children: "Retry references" })
      ] })
    ] }),
    /* @__PURE__ */ jsx(Repositories, { ctrl, choose })
  ] });
}
function Files({ ctrl }) {
  const state = useReview(ctrl);
  const [search, setSearch] = useState("");
  const [unreviewed, setUnreviewed] = useState(false);
  const files = (state.listing?.files || []).filter((f) => (!unreviewed || !f.reviewed) && f.path.toLowerCase().includes(search.toLowerCase()));
  const rows = [];
  let directory = null;
  for (const file of files) {
    const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "Repository root";
    if (dir !== directory) {
      rows.push({ dir });
      directory = dir;
    }
    rows.push(file);
  }
  const active = rows.findIndex((row) => "id" in row && row.id === state.fileId);
  return /* @__PURE__ */ jsxs("div", { className: "hgd-files", children: [
    /* @__PURE__ */ jsx(Input, { "aria-label": "Search files", value: search, placeholder: "Find a file…", onChange: (e) => setSearch(e.target.value) }),
    /* @__PURE__ */ jsxs("label", { className: "hgd-filter", children: [
      /* @__PURE__ */ jsx("input", { type: "checkbox", checked: unreviewed, onChange: (e) => setUnreviewed(e.target.checked) }),
      " Unreviewed only"
    ] }),
    /* @__PURE__ */ jsx(VirtualList, { items: rows, height: 38, active, label: "Changed files", focusable: (row) => "id" in row, render: (row) => "dir" in row ? /* @__PURE__ */ jsx("div", { className: "hgd-directory", title: row.dir, children: row.dir }) : /* @__PURE__ */ jsxs("div", { className: `hgd-file-row ${state.fileId === row.id ? "hgd-selected" : ""}`, children: [
      /* @__PURE__ */ jsxs("button", { "aria-current": state.fileId === row.id ? "true" : void 0, title: row.status === "R" ? `${row.old_path} → ${row.path}` : row.path, onClick: () => void ctrl.selectFile(row.id), children: [
        /* @__PURE__ */ jsx("span", { className: "hgd-status", children: row.status }),
        /* @__PURE__ */ jsx("span", { className: "hgd-filename", children: row.path.split("/").at(-1) }),
        /* @__PURE__ */ jsx("small", { children: row.binary ? "binary" : `+${row.added} −${row.deleted}` })
      ] }),
      /* @__PURE__ */ jsx("input", { type: "checkbox", "aria-label": `Reviewed ${row.path}`, checked: row.reviewed, disabled: state.saving.includes(row.id), onChange: (e) => void ctrl.review(row.id, e.target.checked) })
    ] }) }),
    !files.length && /* @__PURE__ */ jsx("p", { className: "hgd-muted", children: state.listing?.files.length ? "No files match this filter." : "This commit has no changed files." })
  ] });
}
function diffRows(diff, split) {
  const rows = [];
  for (const hunk of diff?.hunks || []) {
    rows.push({ header: hunk.header });
    for (let i = 0; i < hunk.lines.length; ) {
      const line = hunk.lines[i];
      if (!split) {
        rows.push({ line });
        i++;
        continue;
      }
      if (line.kind === "delete" || line.kind === "add") {
        const deleted = [], added = [];
        while (hunk.lines[i]?.kind === "delete") deleted.push(hunk.lines[i++]);
        while (hunk.lines[i]?.kind === "add") added.push(hunk.lines[i++]);
        for (let j = 0; j < Math.max(deleted.length, added.length); j++) rows.push({ left: deleted[j], right: added[j] });
      } else {
        rows.push({ left: line, right: line });
        i++;
      }
    }
  }
  return rows;
}
function Line({ line, side }) {
  return /* @__PURE__ */ jsxs("div", { className: `hgd-line ${line ? `hgd-${line.kind}` : "hgd-blank"}`, children: [
    !side && /* @__PURE__ */ jsx("span", { className: "hgd-number", children: line?.old }),
    /* @__PURE__ */ jsx("span", { className: "hgd-number", children: side === "left" ? line?.old : line?.new }),
    /* @__PURE__ */ jsx("span", { className: "hgd-sign", children: line?.kind === "add" ? "+" : line?.kind === "delete" ? "−" : line?.kind === "note" ? "\\" : " " }),
    /* @__PURE__ */ jsx("code", { children: line?.text || " " })
  ] });
}
function DiffView({ ctrl, expanded }) {
  const state = useReview(ctrl);
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  const [mode, setMode] = useState(ctrl.storage.get("diffMode", "split"));
  useLayoutEffect(() => {
    const obs = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);
  const split = expanded && mode === "split" && width >= 900;
  const rows = useMemo(() => diffRows(state.diff, split), [state.diff, split]);
  const columnWidth = useMemo(() => (state.diff?.hunks || []).reduce((max, h) => h.lines.reduce((n, l) => Math.max(n, l.text.replace(/\t/g, "    ").length * 8 + 95), max), 450), [state.diff]);
  const file = state.listing?.files.find((f) => f.id === state.fileId);
  return /* @__PURE__ */ jsxs("div", { className: "hgd-diff", ref, children: [
    /* @__PURE__ */ jsxs("div", { className: "hgd-diff-header", children: [
      /* @__PURE__ */ jsx("strong", { title: file?.path, children: file?.path || "Select a file" }),
      file && /* @__PURE__ */ jsxs("label", { children: [
        /* @__PURE__ */ jsx("input", { type: "checkbox", checked: file.reviewed, disabled: state.saving.includes(file.id), onChange: (e) => void ctrl.review(file.id, e.target.checked) }),
        " Reviewed"
      ] })
    ] }),
    file?.status === "R" && /* @__PURE__ */ jsxs("div", { className: "hgd-muted hgd-padded", children: [
      "Renamed from ",
      file.old_path
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "hgd-toolbar", children: [
      expanded && /* @__PURE__ */ jsxs("label", { children: [
        "View ",
        /* @__PURE__ */ jsxs("select", { "aria-label": "Diff layout", value: split ? "split" : "unified", onChange: (e) => {
          const value = e.target.value;
          setMode(value);
          ctrl.storage.set("diffMode", value);
        }, children: [
          /* @__PURE__ */ jsx("option", { value: "unified", children: "Unified" }),
          /* @__PURE__ */ jsxs("option", { value: "split", disabled: width < 900, children: [
            "Side by side",
            width < 900 ? " (widen view)" : ""
          ] })
        ] })
      ] }),
      /* @__PURE__ */ jsx(Button, { disabled: !state.fileId || state.loading || state.context >= 1e3, onClick: () => void ctrl.selectFile(state.fileId, Math.min(1e3, state.context < 20 ? 20 : state.context * 5)), children: "More context" }),
      /* @__PURE__ */ jsxs("span", { className: "hgd-muted", children: [
        state.context,
        " context lines"
      ] })
    ] }),
    state.loading && /* @__PURE__ */ jsx("div", { className: "hgd-empty", role: "status", children: "Loading file changes…" }),
    !state.loading && state.diff?.message && /* @__PURE__ */ jsx("div", { className: "hgd-notice", role: "status", children: state.diff.message }),
    !state.loading && state.diff?.kind === "submodule" && /* @__PURE__ */ jsx("div", { className: "hgd-notice", children: "Submodule pointer changed" }),
    !state.loading && !!rows.length && /* @__PURE__ */ jsx(VirtualList, { items: rows, height: 24, label: "File diff", initialScroll: ctrl.scrollTop(), onScroll: (top) => ctrl.rememberScroll(top), render: (row) => "header" in row ? /* @__PURE__ */ jsx("div", { className: "hgd-hunk", children: row.header }) : row.line ? /* @__PURE__ */ jsx(Line, { line: row.line }) : /* @__PURE__ */ jsxs("div", { className: "hgd-split", style: { minWidth: columnWidth * 2 }, children: [
      /* @__PURE__ */ jsx(Line, { line: row.left, side: "left" }),
      /* @__PURE__ */ jsx(Line, { line: row.right, side: "right" })
    ] }) }, `${state.commitId}:${state.parent}:${state.fileId}:${split}`)
  ] });
}
function ReviewPane({ ctrl, expanded = false, expand }) {
  const state = useReview(ctrl);
  const [dialog, setDialog] = useState(null);
  const [filesOpen, setFilesOpen] = useState(true);
  const [commitSearch, setCommitSearch] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    setSettingsOpen(false);
    setDialog(null);
    setCommitSearch("");
  }, [ctrl, state.navigation]);
  const commits = state.snapshot?.commits || [];
  const index = commits.findIndex((c) => c.id === state.commitId);
  const commit = commits[index];
  const reviewed = state.listing?.files.filter((f) => f.reviewed).length || 0;
  const choose = (hash) => setDialog({ hash });
  return /* @__PURE__ */ jsxs("div", { className: `hgd hgd-pane ${expanded ? "hgd-expanded" : ""}`, children: [
    /* @__PURE__ */ jsx(Styles, {}),
    /* @__PURE__ */ jsxs("header", { className: "hgd-header", children: [
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("strong", { children: expanded ? state.snapshot?.session.title || "Commit review" : "Session commits" }),
        /* @__PURE__ */ jsx("span", { className: "hgd-count", children: commits.length })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "hgd-actions", children: [
        /* @__PURE__ */ jsx(Button, { "aria-label": "Refresh commits", onClick: () => void ctrl.refresh(true), disabled: state.refreshing, children: "↻" }),
        !expanded && /* @__PURE__ */ jsx(Button, { onClick: expand, children: "Expand ↗" }),
        /* @__PURE__ */ jsx(Button, { "aria-label": "Plugin settings", onClick: () => setSettingsOpen((v) => !v), children: "Settings" })
      ] })
    ] }),
    state.snapshot?.scanning && /* @__PURE__ */ jsx("div", { className: "hgd-scan", role: "status", children: "Checking conversation references…" }),
    state.error && /* @__PURE__ */ jsxs("div", { className: "hgd-error", role: "alert", children: [
      state.error,
      /* @__PURE__ */ jsx(Button, { onClick: () => {
        if (state.commitId) void ctrl.selectCommit(state.commitId, state.parent);
        else void ctrl.refresh(true);
      }, children: "Retry" })
    ] }),
    !!state.snapshot?.errors.length && /* @__PURE__ */ jsxs("details", { className: "hgd-details hgd-error", children: [
      /* @__PURE__ */ jsxs("summary", { children: [
        state.snapshot.errors.length,
        " repository or scan ",
        state.snapshot.errors.length === 1 ? "notice" : "notices"
      ] }),
      state.snapshot.errors.map((e, i) => /* @__PURE__ */ jsx("p", { children: e.message }, i))
    ] }),
    settingsOpen ? /* @__PURE__ */ jsx(Settings, { ctrl }) : !state.commitId ? /* @__PURE__ */ jsx(CommitOverview, { ctrl, choose }) : /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsxs("div", { className: "hgd-selection", children: [
        /* @__PURE__ */ jsxs("div", { className: "hgd-row", children: [
          /* @__PURE__ */ jsx(Button, { onClick: () => ctrl.overview(), children: "← All commits" }),
          /* @__PURE__ */ jsx("span", { className: "hgd-grow" }),
          /* @__PURE__ */ jsx(Button, { "aria-label": "Previous commit", disabled: index <= 0, onClick: () => void ctrl.selectCommit(commits[index - 1].id), children: "↑" }),
          /* @__PURE__ */ jsxs("span", { children: [
            index + 1,
            " / ",
            commits.length
          ] }),
          /* @__PURE__ */ jsx(Button, { "aria-label": "Next commit", disabled: index < 0 || index >= commits.length - 1, onClick: () => void ctrl.selectCommit(commits[index + 1].id), children: "↓" })
        ] }),
        /* @__PURE__ */ jsx(Input, { "aria-label": "Filter commit picker", placeholder: "Find another commit…", value: commitSearch, onChange: (e) => setCommitSearch(e.target.value) }),
        /* @__PURE__ */ jsx("select", { "aria-label": "Selected commit", value: state.commitId, onChange: (e) => {
          void ctrl.selectCommit(e.target.value);
          setCommitSearch("");
        }, children: commits.filter((c) => c.id === state.commitId || `${c.subject} ${c.sha}`.toLowerCase().includes(commitSearch.toLowerCase())).map((c) => /* @__PURE__ */ jsxs("option", { value: c.id, children: [
          c.sha.slice(0, 8),
          " · ",
          c.subject
        ] }, c.id)) }),
        /* @__PURE__ */ jsxs("div", { className: "hgd-row hgd-muted", children: [
          /* @__PURE__ */ jsx("span", { children: commit?.repo_name }),
          /* @__PURE__ */ jsxs("span", { children: [
            reviewed,
            " of ",
            state.listing?.files.length ?? commit?.file_count ?? "—",
            " files reviewed"
          ] })
        ] }),
        (commit?.parents.length || 0) > 1 && /* @__PURE__ */ jsxs("label", { children: [
          "Compare with parent ",
          /* @__PURE__ */ jsx("select", { "aria-label": "Comparison parent", value: state.parent ?? commit.parents[0], onChange: (e) => void ctrl.selectCommit(state.commitId, e.target.value), children: commit.parents.map((parent, i) => /* @__PURE__ */ jsxs("option", { value: parent, children: [
            i + 1,
            ": ",
            parent.slice(0, 8),
            i === 0 ? " (first parent)" : ""
          ] }, parent)) })
        ] }),
        /* @__PURE__ */ jsxs("details", { children: [
          /* @__PURE__ */ jsx("summary", { className: "hgd-muted", children: "Commit details" }),
          /* @__PURE__ */ jsxs("p", { children: [
            commit?.author,
            " · ",
            commit?.date
          ] }),
          /* @__PURE__ */ jsx("code", { className: "hgd-full-sha", children: commit?.sha })
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "hgd-review-body", children: [
        /* @__PURE__ */ jsxs("section", { className: `hgd-file-section ${filesOpen ? "" : "hgd-collapsed"}`, children: [
          /* @__PURE__ */ jsxs("button", { className: "hgd-files-toggle", "aria-expanded": filesOpen, onClick: () => setFilesOpen((v) => !v), children: [
            filesOpen ? "▾" : "▸",
            " Files (",
            state.listing?.files.length ?? "…",
            ")"
          ] }),
          filesOpen && /* @__PURE__ */ jsx(Files, { ctrl })
        ] }),
        /* @__PURE__ */ jsx(DiffView, { ctrl, expanded })
      ] })
    ] }),
    dialog && /* @__PURE__ */ jsx(RepositoryDialog, { ctrl, hash: dialog.hash, close: () => setDialog(null) })
  ] });
}

// src/composer.tsx
import { useLayoutEffect as useLayoutEffect2, useRef as useRef2, useState as useState2 } from "react";
import { Button as Button2, Input as Input2, Popover, PopoverContent, PopoverTrigger } from "@hermes/plugin-sdk";
import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
var complete = (commit) => commit.file_count !== null && commit.reviewed_count === commit.file_count;
var progress = (commit) => `${commit.reviewed_count || 0} of ${commit.file_count ?? "unknown"} files reviewed`;
var description = (commit) => `${commit.sha}
${commit.subject}
${commit.repo_name} · ${progress(commit)}`;
function CommitStrip({ ctrl, open }) {
  const state = useReview(ctrl);
  const strip = useRef2(null);
  const results = useRef2(null);
  const picked = useRef2(false);
  const [limit, setLimit] = useState2(3);
  const [pickerOpen, setPickerOpen] = useState2(false);
  const [query, setQuery] = useState2("");
  useLayoutEffect2(() => {
    if (!strip.current) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width || 0;
      setLimit(width >= 790 ? 3 : width >= 620 ? 2 : width >= 440 ? 1 : 0);
    });
    observer.observe(strip.current);
    return () => observer.disconnect();
  }, []);
  const commits = state.snapshot?.commits || [];
  const filtered = commits.filter((c) => `${c.sha} ${c.subject} ${c.repo_name}`.toLowerCase().includes(query.trim().toLowerCase()));
  const recent = commits.slice(0, limit);
  const remaining = commits.length - recent.length;
  const title = state.snapshot?.session.title || "Untitled chat";
  const resume = ctrl.resumeTarget;
  const resumedCommit = commits.find((c) => c.id === resume?.commitId);
  const choose = (commit) => {
    picked.current = true;
    setPickerOpen(false);
    open(commit.id);
  };
  if (!commits.length || !ctrl.showChips) return null;
  return /* @__PURE__ */ jsxs2("div", { ref: strip, className: "hgd hgd-commit-strip", role: "region", "aria-label": `Commits for ${title} (focused chat)`, children: [
    /* @__PURE__ */ jsx2(Styles, {}),
    /* @__PURE__ */ jsxs2(Button2, { variant: "ghost", size: "xs", className: "hgd-chip hgd-commit-count", title: `Review commits in the focused chat: ${title}`, onClick: () => open(), children: [
      "Commits · ",
      commits.length,
      ctrl.newCount > 0 && /* @__PURE__ */ jsxs2("span", { className: "hgd-new", children: [
        ctrl.newCount,
        " new"
      ] })
    ] }),
    recent.map((commit) => /* @__PURE__ */ jsxs2(
      Button2,
      {
        variant: "ghost",
        size: "xs",
        className: "hgd-chip hgd-hash-chip",
        "aria-label": `Review ${commit.sha.slice(0, 8)}: ${commit.subject}${complete(commit) ? " (reviewed)" : ""}`,
        title: description(commit),
        onClick: () => choose(commit),
        children: [
          complete(commit) && /* @__PURE__ */ jsx2("span", { "aria-hidden": "true", children: "✓" }),
          /* @__PURE__ */ jsx2("code", { children: commit.sha.slice(0, 8) }),
          /* @__PURE__ */ jsx2("span", { className: "hgd-chip-subject", children: commit.subject }),
          ctrl.isNew(commit.id) && /* @__PURE__ */ jsx2("span", { className: "hgd-new", children: "New" })
        ]
      },
      commit.id
    )),
    remaining > 0 && /* @__PURE__ */ jsxs2(Popover, { modal: true, open: pickerOpen, onOpenChange: (value) => {
      picked.current = false;
      setPickerOpen(value);
      if (value) setQuery("");
    }, children: [
      /* @__PURE__ */ jsx2(PopoverTrigger, { asChild: true, children: /* @__PURE__ */ jsxs2(Button2, { variant: "ghost", size: "xs", className: "hgd-chip", "aria-label": `Find a commit (${remaining} more)`, title: "Search all commits by hash, subject or repository", children: [
        "+",
        remaining
      ] }) }),
      /* @__PURE__ */ jsxs2(
        PopoverContent,
        {
          side: "top",
          align: "start",
          collisionPadding: 12,
          className: "hgd hgd-commit-picker",
          "aria-label": `Find a commit in ${title}`,
          onCloseAutoFocus: (event) => {
            if (picked.current) event.preventDefault();
          },
          children: [
            /* @__PURE__ */ jsx2(Styles, {}),
            /* @__PURE__ */ jsxs2("div", { className: "hgd-picker-heading", children: [
              /* @__PURE__ */ jsx2("strong", { children: "Session commits" }),
              /* @__PURE__ */ jsx2("span", { className: "hgd-muted", children: commits.length })
            ] }),
            /* @__PURE__ */ jsxs2("p", { className: "hgd-picker-chat", title, children: [
              "Focused chat: ",
              title
            ] }),
            /* @__PURE__ */ jsx2(
              Input2,
              {
                "aria-label": "Find a session commit",
                placeholder: "Hash, subject or repository…",
                value: query,
                onChange: (event) => setQuery(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    results.current?.querySelector("button")?.focus();
                  }
                  if (event.key === "Enter" && !event.nativeEvent.isComposing && filtered.length === 1) {
                    event.preventDefault();
                    choose(filtered[0]);
                  }
                }
              }
            ),
            /* @__PURE__ */ jsxs2("div", { className: "hgd-picker-results", ref: results, children: [
              /* @__PURE__ */ jsx2(VirtualList, { items: filtered, height: 70, label: "Matching commits", render: (commit) => /* @__PURE__ */ jsxs2("button", { className: "hgd-picker-result", title: description(commit), onClick: () => choose(commit), children: [
                /* @__PURE__ */ jsxs2("div", { className: "hgd-row", children: [
                  /* @__PURE__ */ jsx2("code", { children: commit.sha.slice(0, 8) }),
                  complete(commit) && /* @__PURE__ */ jsx2("span", { children: "✓ Reviewed" }),
                  ctrl.isNew(commit.id) && /* @__PURE__ */ jsx2("span", { className: "hgd-new", children: "New" })
                ] }),
                /* @__PURE__ */ jsx2("strong", { children: commit.subject }),
                /* @__PURE__ */ jsxs2("small", { children: [
                  commit.repo_name,
                  " · ",
                  progress(commit)
                ] })
              ] }) }, query),
              !filtered.length && /* @__PURE__ */ jsx2("p", { className: "hgd-empty", children: "No matching commits." })
            ] })
          ]
        }
      )
    ] }),
    resumedCommit && /* @__PURE__ */ jsx2(
      Button2,
      {
        variant: "ghost",
        size: "xs",
        className: "hgd-chip hgd-resume",
        "aria-label": "Resume review",
        title: `Resume ${resumedCommit.sha.slice(0, 8)}: ${resumedCommit.subject} — last file and scroll position`,
        onClick: () => open(void 0, true),
        children: "Resume review"
      }
    )
  ] });
}

// src/plugin.tsx
import { jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
var PluginApp = class {
  constructor(ctx) {
    this.ctx = ctx;
  }
  current = null;
  expanded = null;
  status = "Open a chat to discover its commits.";
  controllers = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  revision = 0;
  generation = 0;
  sideClose = null;
  expandedClose = null;
  capabilities = /* @__PURE__ */ new Map();
  eventPending = false;
  disposed = false;
  subscribe = (fn) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.revision;
  emit() {
    this.revision++;
    this.listeners.forEach((fn) => fn());
  }
  rpc = async (route, method, params = {}) => {
    const key = JSON.stringify([route.connectionId, route.profile]);
    if (!this.capabilities.has(key)) {
      const promise = host.requestProfile(route, "runtime.describe", {}).then((info) => {
        if (!info.capabilities?.includes("plugin-rpc-v1")) throw new Error("Update Hermes to 0.23.1 or newer with plugin-rpc-v1 support.");
      }).catch((error) => {
        this.capabilities.delete(key);
        throw error;
      });
      this.capabilities.set(key, promise);
    }
    await this.capabilities.get(key);
    return host.requestProfile(route, `plugin.${ID}.${method}`, { ...params, session_id: route.sessionId });
  };
  async focus() {
    const token = ++this.generation;
    const sessionId = host.state.focusedSessionId?.get();
    const storedId = host.state.focusedStoredSessionId?.get() || sessionId;
    const owner = host.state.focusedSessionOwner?.get();
    if (!storedId || !sessionId || !owner) {
      this.current = null;
      this.status = storedId ? "Waiting for the chat’s gateway and profile…" : "Open a chat to discover its commits.";
      this.emit();
      return;
    }
    if (this.current && this.current.key !== JSON.stringify([owner.connectionId, owner.profile, storedId])) {
      this.current = null;
      this.status = "Loading this chat’s commits…";
      this.emit();
    }
    try {
      const routes = await host.profileRoutes();
      if (token !== this.generation || this.disposed) return;
      const exact = routes.find((r) => r.connectionId === owner.connectionId && r.profile === owner.profile);
      if (!exact) throw new Error("Connect to this chat’s owning gateway and profile, then retry.");
      const route = { ...exact, sessionId, storedId };
      const key = routeKey(route);
      let ctrl = this.controllers.get(key);
      if (!ctrl) {
        ctrl = new ReviewController(route, this.rpc, this.ctx.storage, (controller) => {
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
        if (old !== ctrl && old !== this.expanded) {
          old.dispose();
          this.controllers.delete(oldKey);
        }
      }
      await ctrl.refresh();
    } catch (error) {
      if (token === this.generation) {
        this.current = null;
        this.status = errorMessage(error);
        this.emit();
      }
    }
  }
  openSide() {
    if (this.current) this.ctx.storage.set(`opened:${this.current.key}`, true);
    if (this.sideClose && host.revealPane) {
      host.revealPane(`plugin-workspace:${ID}:side`);
      return;
    }
    this.sideClose = host.openWorkspace(`${ID}:side`, {
      title: "Session commits",
      minWidth: "24rem",
      dock: { pane: "workspace", pos: "right" },
      render: () => /* @__PURE__ */ jsx3(Side, { app: this }),
      onClose: () => {
        this.sideClose = null;
      }
    });
  }
  openReview(ctrl, commitId, resume = false) {
    const owner = host.state.focusedSessionOwner?.get();
    const storedId = host.state.focusedStoredSessionId?.get() || host.state.focusedSessionId?.get();
    if (ctrl !== this.current || !owner || ctrl.key !== JSON.stringify([owner.connectionId, owner.profile, storedId])) return;
    if (commitId && !ctrl.state.snapshot?.commits.some((c) => c.id === commitId)) return;
    const target = resume ? ctrl.resumeTarget : null;
    if (commitId || target) void ctrl.navigate(commitId || target.commitId, target?.parent);
    this.ctx.storage.set(`opened:${ctrl.key}`, true);
    if (this.expanded === ctrl && this.expandedClose) {
      if (host.revealPane) host.revealPane(`plugin-workspace:${ID}:expanded`);
      else this.expand(ctrl);
    } else this.openSide();
  }
  expand(ctrl) {
    this.sideClose?.();
    this.sideClose = null;
    this.expanded = ctrl;
    this.expandedClose = host.openWorkspace(`${ID}:expanded`, {
      title: "Commit review",
      minWidth: "30rem",
      render: () => /* @__PURE__ */ jsx3(ReviewPane, { ctrl, expanded: true, expand: () => {
      } }),
      onClose: () => {
        this.expanded = null;
        this.expandedClose = null;
      }
    });
  }
  poll() {
    if (this.disposed || document.hidden) return;
    void this.current?.refresh();
    if (this.expanded && this.expanded !== this.current && host.paneVisibility(`plugin-workspace:${ID}:expanded`).get()) void this.expanded.refresh();
  }
  start() {
    if (typeof host.openWorkspace !== "function" || typeof host.profileRoutes !== "function" || typeof host.requestProfile !== "function" || typeof host.paneVisibility !== "function" || !host.state.focusedSessionOwner || typeof this.ctx.registerSettingsPage !== "function") {
      this.status = "Update Hermes to 0.23.1 with the Desktop workspace and session-owner APIs.";
      this.ctx.register({ id: "unavailable", area: STATUSBAR_AREAS.right, render: () => /* @__PURE__ */ jsx3("span", { title: this.status, children: "Commit review unavailable" }) });
      return;
    }
    this.ctx.register({ id: "commits", area: STATUSBAR_AREAS.right, render: () => /* @__PURE__ */ jsx3(Badge, { app: this }) });
    if (COMPOSER_AREAS?.underside) this.ctx.register({ id: "commit-chips", area: COMPOSER_AREAS.underside, render: () => /* @__PURE__ */ jsx3(Composer, { app: this }) });
    if (PALETTE_AREA) this.ctx.register({ id: "review-session-commits", area: PALETTE_AREA, data: {
      id: `${ID}:review-session-commits`,
      label: "Review session commits",
      keywords: ["git", "hash", "diff", "resume"],
      detail: () => `${this.current?.state.snapshot?.commits.length || 0} commits in the focused chat`,
      run: () => {
        const ctrl = this.current;
        this.ctx.setTimeout(() => {
          if (ctrl) this.openReview(ctrl, void 0, true);
          else if (!this.current) this.openSide();
        }, 0);
      }
    } });
    this.ctx.registerSettingsPage({ id: "review", title: "Chat Git Hash Differ", render: () => /* @__PURE__ */ jsx3(SettingsPage, { app: this }) });
    for (const key of ["focusedSessionId", "focusedStoredSessionId", "focusedSessionOwner", "connectionId", "gateway"]) {
      if (host.state[key]) this.ctx.onDispose(host.state[key].subscribe(() => {
        void this.focus();
      }));
    }
    this.ctx.onEvent("*", (event) => {
      const type = String(event?.type || "");
      if (!/^(session\.|chat\.|agent\.|tool\.|plugin\.hermes-chat-git-hash-differ\.)/.test(type) || this.eventPending) return;
      this.eventPending = true;
      this.ctx.setTimeout(() => {
        this.eventPending = false;
        this.poll();
      }, 250);
    });
    this.ctx.setInterval(() => this.poll(), 5e3);
    this.ctx.addEventListener(document, "visibilitychange", () => {
      if (!document.hidden) {
        void this.focus();
      }
    });
    this.ctx.onDispose(() => this.dispose());
    void this.focus();
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    this.sideClose?.();
    this.expandedClose?.();
    for (const ctrl of this.controllers.values()) ctrl.dispose();
    this.controllers.clear();
    this.listeners.clear();
  }
};
function Badge({ app }) {
  useSyncExternalStore2(app.subscribe, app.getSnapshot);
  const state = app.current?.state;
  return /* @__PURE__ */ jsxs3("span", { className: "hgd", children: [
    /* @__PURE__ */ jsx3(Styles, {}),
    /* @__PURE__ */ jsxs3(Button3, { variant: "ghost", size: "xs", style: { fontSize: 11, lineHeight: "16px" }, title: state?.error || "Review commits mentioned in this chat", onClick: () => app.current ? app.openReview(app.current) : app.openSide(), children: [
      "Commits · ",
      state?.snapshot?.commits.length || 0,
      state?.snapshot?.scanning ? " …" : state?.error ? " !" : ""
    ] })
  ] });
}
function Composer({ app }) {
  useSyncExternalStore2(app.subscribe, app.getSnapshot);
  const ctrl = app.current;
  return ctrl?.showChips && ctrl.state.snapshot?.commits.length ? /* @__PURE__ */ jsx3(
    CommitStrip,
    {
      ctrl,
      open: (commitId, resume) => app.openReview(ctrl, commitId, resume)
    },
    ctrl.key
  ) : null;
}
function Side({ app }) {
  useSyncExternalStore2(app.subscribe, app.getSnapshot);
  return app.current ? /* @__PURE__ */ jsx3(ReviewPane, { ctrl: app.current, expand: () => app.expand(app.current) }, app.current.key) : /* @__PURE__ */ jsxs3("div", { className: "hgd hgd-empty", children: [
    /* @__PURE__ */ jsx3(Styles, {}),
    app.status,
    /* @__PURE__ */ jsx3("p", { children: /* @__PURE__ */ jsx3(Button3, { onClick: () => void app.focus(), children: "Retry" }) })
  ] });
}
function SettingsPage({ app }) {
  useSyncExternalStore2(app.subscribe, app.getSnapshot);
  return app.current ? /* @__PURE__ */ jsx3(Settings, { ctrl: app.current }) : /* @__PURE__ */ jsxs3("div", { className: "hgd hgd-empty", children: [
    /* @__PURE__ */ jsx3(Styles, {}),
    "Open a chat to configure its profile’s commit review settings."
  ] });
}
var plugin_default = {
  id: ID,
  name: "Chat Git Hash Differ",
  version: "0.2.0",
  defaultEnabled: false,
  register(ctx) {
    new PluginApp(ctx).start();
  }
};
export {
  PluginApp,
  plugin_default as default
};
