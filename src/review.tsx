import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button as NativeButton, Input, Switch } from '@hermes/plugin-sdk';
import { ReviewController } from './controller';
import type { ChangedFile, DiffLine, FileDiff } from './types';
import css from './styles.css';

const Button = (props: React.ComponentProps<typeof NativeButton>) => <NativeButton size="sm" variant="secondary" {...props}/>;

export const Styles = () => <style>{css}</style>;
export const useReview = (ctrl: ReviewController) => useSyncExternalStore(ctrl.subscribe, ctrl.getSnapshot);

export function VirtualList<T>({ items, height = 44, label, render, active = -1, initialScroll = 0, onScroll, focusable = () => true }:
  { items: T[]; height?: number; label: string; render(item: T, index: number): React.ReactNode; active?: number; initialScroll?: number; onScroll?: (top: number) => void; focusable?: (item: T) => boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: initialScroll, height: 400 });
  useLayoutEffect(() => {
    const el = ref.current!;
    el.scrollTop = initialScroll;
    const resize = () => setView({ top: el.scrollTop, height: el.clientHeight || 400 });
    const observer = new ResizeObserver(resize); observer.observe(el); resize();
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
  return <div className="hgd-virtual" ref={ref} role="list" aria-label={label}
    onScroll={e => { const top = e.currentTarget.scrollTop; setView(v => ({ ...v, top })); onScroll?.(top); }}
    onKeyDown={e => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const index = Number((e.target as HTMLElement).closest('[data-row]')?.getAttribute('data-row'));
      if (!Number.isFinite(index)) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      let next = index + step;
      while (next >= 0 && next < items.length && !focusable(items[next])) next += step;
      if (next < 0 || next >= items.length) return;
      e.preventDefault(); ref.current!.scrollTop = Math.max(0, next * height - view.height / 2);
      requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-row="${next}"] button`)?.focus());
    }}>
    <div style={{ height: items.length * height, position: 'relative', minWidth: '100%' }}>
      {items.slice(start, end).map((item, n) => <div role="listitem" data-row={start + n} key={start + n}
        style={{ position: 'absolute', top: (start + n) * height, height, width: '100%' }}>{render(item, start + n)}</div>)}
    </div>
  </div>;
}

export function Settings({ ctrl }: { ctrl: ReviewController }) {
  const state = useReview(ctrl);
  const id = useId();
  return <div className="hgd hgd-settings"><Styles/><h2>Chat Git Hash Differ</h2>
    <div className="hgd-setting"><div><label htmlFor={`${id}-auto-open`}>Automatically open the commit panel</label>
      <p>Open once per chat when a valid commit is found. Later discoveries leave your review in place.</p></div>
      <Switch id={`${id}-auto-open`} checked={state.snapshot?.auto_open ?? true} onCheckedChange={(value: boolean) => void ctrl.autoOpen(value)} /></div>
    <div className="hgd-setting"><div><label htmlFor={`${id}-chips`}>Show commit chips below the composer</label>
      <p>Quick access to the focused chat’s commits, even when review is closed. Saved on this client.</p></div>
      <Switch id={`${id}-chips`} checked={ctrl.showChips} onCheckedChange={(value: boolean) => ctrl.setShowChips(value)} /></div>
    <p>Repository paths refer to the machine running this chat’s Hermes backend. Review progress is shared with its Webapp.</p>
    {state.error && <p role="alert">{state.error}</p>}
  </div>;
}

function RepositoryDialog({ ctrl, hash, close }: { ctrl: ReviewController; hash?: string; close(): void }) {
  const state = useReview(ctrl);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const save = async (value: string) => { setBusy(true); if (await ctrl.addRepository(value, hash)) close(); setBusy(false); };
  return <div className="hgd-dialog-backdrop" onKeyDown={e => {
    if (e.key === 'Escape') close();
    if (e.key === 'Tab') {
      const nodes = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input, select'));
      if (e.shiftKey && document.activeElement === nodes[0]) { e.preventDefault(); nodes.at(-1)?.focus(); }
      if (!e.shiftKey && document.activeElement === nodes.at(-1)) { e.preventDefault(); nodes[0]?.focus(); }
    }
  }}><div className="hgd-dialog" role="dialog" aria-modal="true" aria-label={hash ? `Resolve ${hash}` : 'Add repository'}>
    <h3>{hash ? `Choose repository for ${hash}` : 'Add repository'}</h3>
    <p>Enter a repository directory on the Hermes host.</p>
    {hash && state.snapshot?.repositories.map(repo => <Button key={repo.id} disabled={busy} onClick={() => void save(repo.path)}>{repo.name}</Button>)}
    <form onSubmit={e => { e.preventDefault(); if (path.trim()) void save(path.trim()); }}>
      <Input ref={input} aria-label="Repository path on Hermes host" value={path} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPath(e.target.value)} placeholder="C:\Projects\my-repository or /srv/project" />
      {state.error && <p role="alert">{state.error}</p>}
      <div className="hgd-actions"><Button type="button" onClick={close}>Cancel</Button><Button type="submit" disabled={busy || !path.trim()}>{busy ? 'Checking…' : 'Use repository'}</Button></div>
    </form>
  </div></div>;
}

function Repositories({ ctrl, choose }: { ctrl: ReviewController; choose(hash?: string): void }) {
  const state = useReview(ctrl);
  return <details className="hgd-details"><summary>Repositories · {state.snapshot?.repositories.length || 0}</summary>
    {state.snapshot?.repositories.map(repo => <div className="hgd-repo" key={repo.id}>
      <span title={repo.path}>{repo.path}</span><Button aria-label={`Remove repository ${repo.name}`} onClick={() => void ctrl.removeRepository(repo.id)}>Remove</Button></div>)}
    <Button onClick={() => choose()}>Add repository</Button>
  </details>;
}

function CommitOverview({ ctrl, choose }: { ctrl: ReviewController; choose(hash?: string): void }) {
  const state = useReview(ctrl);
  const [search, setSearch] = useState('');
  const commits = (state.snapshot?.commits || []).filter(c => `${c.subject} ${c.sha} ${c.repo_name}`.toLowerCase().includes(search.toLowerCase()));
  return <>
    <div className="hgd-padded"><Input aria-label="Search commits" placeholder="Find a commit or repository…" value={search} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)} /></div>
    <div className="hgd-commit-list">
      {!commits.length && <div className="hgd-empty"><strong>{state.snapshot?.scanning ? 'Looking for commits…' : 'No matching commits'}</strong><p>Hashes mentioned in messages and tool output will appear here. Add a repository if it is outside the chat’s working folder.</p><Button onClick={() => choose()}>Add repository</Button></div>}
      <VirtualList items={commits} height={94} label="Detected commits" render={commit => <button className="hgd-commit" onClick={() => void ctrl.selectCommit(commit.id)}>
        <div className="hgd-row"><code>{commit.sha.slice(0, 8)}</code><span className="hgd-muted">{commit.repo_name}</span><span className="hgd-progress">{commit.file_count !== null && commit.reviewed_count === commit.file_count ? '✓ Reviewed' : `${commit.reviewed_count || 0}/${commit.file_count ?? '—'} reviewed`}</span></div>
        <strong title={commit.subject}>{commit.subject}</strong>
        <div className="hgd-row hgd-muted"><span>{commit.file_count ?? '—'} files</span><span>{commit.occurrences} {commit.occurrences === 1 ? 'mention' : 'mentions'}</span>{commit.problem && <span>⚠ {commit.problem.message}</span>}</div>
      </button>} />
    </div>
    {!!state.snapshot?.unresolved.length && <details className="hgd-details"><summary>Unresolved references · {state.snapshot.unresolved.length}</summary><div className="hgd-unresolved">
      {state.snapshot.unresolved.map((ref, n) => <div className="hgd-repo" key={`${ref.hash}:${n}`}><span><code>{ref.hash}</code><small>{ref.reason === 'ambiguous' ? 'Choose a matching repository or use a longer hash' : 'Not available in linked repositories'}</small></span><Button onClick={() => choose(ref.hash)}>Choose repository</Button></div>)}
      <Button onClick={() => void ctrl.refresh(true)}>Retry references</Button></div></details>}
    <Repositories ctrl={ctrl} choose={choose}/>
  </>;
}

function Files({ ctrl }: { ctrl: ReviewController }) {
  const state = useReview(ctrl);
  const [search, setSearch] = useState('');
  const [unreviewed, setUnreviewed] = useState(false);
  const files = (state.listing?.files || []).filter(f => (!unreviewed || !f.reviewed) && f.path.toLowerCase().includes(search.toLowerCase()));
  const rows: ({ dir: string } | ChangedFile)[] = [];
  let directory: string | null = null;
  for (const file of files) {
    const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : 'Repository root';
    if (dir !== directory) { rows.push({ dir }); directory = dir; }
    rows.push(file);
  }
  const active = rows.findIndex(row => 'id' in row && row.id === state.fileId);
  return <div className="hgd-files"><Input aria-label="Search files" value={search} placeholder="Find a file…" onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)} />
    <label className="hgd-filter"><input type="checkbox" checked={unreviewed} onChange={e => setUnreviewed(e.target.checked)}/> Unreviewed only</label>
    <VirtualList items={rows} height={38} active={active} label="Changed files" focusable={row => 'id' in row} render={row => 'dir' in row ? <div className="hgd-directory" title={row.dir}>{row.dir}</div> : <div className={`hgd-file-row ${state.fileId === row.id ? 'hgd-selected' : ''}`}>
      <button aria-current={state.fileId === row.id ? 'true' : undefined} title={row.status === 'R' ? `${row.old_path} → ${row.path}` : row.path} onClick={() => void ctrl.selectFile(row.id)}><span className="hgd-status">{row.status}</span><span className="hgd-filename">{row.path.split('/').at(-1)}</span><small>{row.binary ? 'binary' : `+${row.added} −${row.deleted}`}</small></button>
      <input type="checkbox" aria-label={`Reviewed ${row.path}`} checked={row.reviewed} disabled={state.saving.includes(row.id)} onChange={e => void ctrl.review(row.id, e.target.checked)}/>
    </div>}/>
    {!files.length && <p className="hgd-muted">{state.listing?.files.length ? 'No files match this filter.' : 'This commit has no changed files.'}</p>}
  </div>;
}

export type RenderRow = { header: string } | { left?: DiffLine; right?: DiffLine; line?: DiffLine };
export function diffRows(diff: FileDiff | null, split: boolean): RenderRow[] {
  const rows: RenderRow[] = [];
  for (const hunk of diff?.hunks || []) {
    rows.push({ header: hunk.header });
    for (let i = 0; i < hunk.lines.length;) {
      const line = hunk.lines[i];
      if (!split) { rows.push({ line }); i++; continue; }
      if (line.kind === 'delete' || line.kind === 'add') {
        const deleted: DiffLine[] = [], added: DiffLine[] = [];
        while (hunk.lines[i]?.kind === 'delete') deleted.push(hunk.lines[i++]);
        while (hunk.lines[i]?.kind === 'add') added.push(hunk.lines[i++]);
        for (let j = 0; j < Math.max(deleted.length, added.length); j++) rows.push({ left: deleted[j], right: added[j] });
      } else { rows.push({ left: line, right: line }); i++; }
    }
  }
  return rows;
}

function Line({ line, side }: { line?: DiffLine; side?: 'left' | 'right' }) {
  return <div className={`hgd-line ${line ? `hgd-${line.kind}` : 'hgd-blank'}`}>
    {!side && <span className="hgd-number">{line?.old}</span>}<span className="hgd-number">{side === 'left' ? line?.old : line?.new}</span>
    <span className="hgd-sign">{line?.kind === 'add' ? '+' : line?.kind === 'delete' ? '−' : line?.kind === 'note' ? '\\' : ' '}</span><code>{line?.text || ' '}</code>
  </div>;
}

function DiffView({ ctrl, expanded }: { ctrl: ReviewController; expanded: boolean }) {
  const state = useReview(ctrl);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [mode, setMode] = useState(ctrl.storage.get<'unified' | 'split'>('diffMode', 'split'));
  useLayoutEffect(() => { const obs = new ResizeObserver(entries => setWidth(entries[0].contentRect.width)); obs.observe(ref.current!); return () => obs.disconnect(); }, []);
  const split = expanded && mode === 'split' && width >= 900;
  const rows = useMemo(() => diffRows(state.diff, split), [state.diff, split]);
  const columnWidth = useMemo(() => (state.diff?.hunks || []).reduce((max, h) => h.lines.reduce((n, l) => Math.max(n, l.text.replace(/\t/g, '    ').length * 8 + 95), max), 450), [state.diff]);
  const file = state.listing?.files.find(f => f.id === state.fileId);
  return <div className="hgd-diff" ref={ref}>
    <div className="hgd-diff-header"><strong title={file?.path}>{file?.path || 'Select a file'}</strong>{file && <label><input type="checkbox" checked={file.reviewed} disabled={state.saving.includes(file.id)} onChange={e => void ctrl.review(file.id, e.target.checked)}/> Reviewed</label>}</div>
    {file?.status === 'R' && <div className="hgd-muted hgd-padded">Renamed from {file.old_path}</div>}
    <div className="hgd-toolbar">
      {expanded && <label>View <select aria-label="Diff layout" value={split ? 'split' : 'unified'} onChange={e => { const value = e.target.value as 'split' | 'unified'; setMode(value); ctrl.storage.set('diffMode', value); }}><option value="unified">Unified</option><option value="split" disabled={width < 900}>Side by side{width < 900 ? ' (widen view)' : ''}</option></select></label>}
      <Button disabled={!state.fileId || state.loading || state.context >= 1000} onClick={() => void ctrl.selectFile(state.fileId!, Math.min(1000, state.context < 20 ? 20 : state.context * 5))}>More context</Button>
      <span className="hgd-muted">{state.context} context lines</span>
    </div>
    {state.loading && <div className="hgd-empty" role="status">Loading file changes…</div>}
    {!state.loading && state.diff?.message && <div className="hgd-notice" role="status">{state.diff.message}</div>}
    {!state.loading && state.diff?.kind === 'submodule' && <div className="hgd-notice">Submodule pointer changed</div>}
    {!state.loading && !!rows.length && <VirtualList key={`${state.commitId}:${state.parent}:${state.fileId}:${split}`} items={rows} height={24} label="File diff" initialScroll={ctrl.scrollTop()} onScroll={top => ctrl.rememberScroll(top)} render={row => 'header' in row ? <div className="hgd-hunk">{row.header}</div> : row.line ? <Line line={row.line}/> : <div className="hgd-split" style={{ minWidth: columnWidth * 2 }}><Line line={row.left} side="left"/><Line line={row.right} side="right"/></div>}/>}
  </div>;
}

export function ReviewPane({ ctrl, expanded = false, expand }: { ctrl: ReviewController; expanded?: boolean; expand(): void }) {
  const state = useReview(ctrl);
  const [dialog, setDialog] = useState<{ hash?: string } | null>(null);
  const [filesOpen, setFilesOpen] = useState(true);
  const [commitSearch, setCommitSearch] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => { setSettingsOpen(false); setDialog(null); setCommitSearch(''); }, [ctrl, state.navigation]);
  const commits = state.snapshot?.commits || [];
  const index = commits.findIndex(c => c.id === state.commitId);
  const commit = commits[index];
  const reviewed = state.listing?.files.filter(f => f.reviewed).length || 0;
  const choose = (hash?: string) => setDialog({ hash });
  return <div className={`hgd hgd-pane ${expanded ? 'hgd-expanded' : ''}`}><Styles/>
    <header className="hgd-header"><div><strong>{expanded ? state.snapshot?.session.title || 'Commit review' : 'Session commits'}</strong><span className="hgd-count">{commits.length}</span></div>
      <div className="hgd-actions"><Button aria-label="Refresh commits" onClick={() => void ctrl.refresh(true)} disabled={state.refreshing}>↻</Button>{!expanded && <Button onClick={expand}>Expand ↗</Button>}<Button aria-label="Plugin settings" onClick={() => setSettingsOpen(v => !v)}>Settings</Button></div></header>
    {state.snapshot?.scanning && <div className="hgd-scan" role="status">Checking conversation references…</div>}
    {state.error && <div className="hgd-error" role="alert">{state.error}<Button onClick={() => { if (state.commitId) void ctrl.selectCommit(state.commitId, state.parent); else void ctrl.refresh(true); }}>Retry</Button></div>}
    {!!state.snapshot?.errors.length && <details className="hgd-details hgd-error"><summary>{state.snapshot.errors.length} repository or scan {state.snapshot.errors.length === 1 ? 'notice' : 'notices'}</summary>{state.snapshot.errors.map((e, i) => <p key={i}>{e.message}</p>)}</details>}
    {settingsOpen ? <Settings ctrl={ctrl}/> : !state.commitId ? <CommitOverview ctrl={ctrl} choose={choose}/> : <>
      <div className="hgd-selection"><div className="hgd-row"><Button onClick={() => ctrl.overview()}>← All commits</Button><span className="hgd-grow"/><Button aria-label="Previous commit" disabled={index <= 0} onClick={() => void ctrl.selectCommit(commits[index - 1].id)}>↑</Button><span>{index + 1} / {commits.length}</span><Button aria-label="Next commit" disabled={index < 0 || index >= commits.length - 1} onClick={() => void ctrl.selectCommit(commits[index + 1].id)}>↓</Button></div>
        <Input aria-label="Filter commit picker" placeholder="Find another commit…" value={commitSearch} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCommitSearch(e.target.value)}/>
        <select aria-label="Selected commit" value={state.commitId} onChange={e => { void ctrl.selectCommit(e.target.value); setCommitSearch(''); }}>{commits.filter(c => c.id === state.commitId || `${c.subject} ${c.sha}`.toLowerCase().includes(commitSearch.toLowerCase())).map(c => <option key={c.id} value={c.id}>{c.sha.slice(0, 8)} · {c.subject}</option>)}</select>
        <div className="hgd-row hgd-muted"><span>{commit?.repo_name}</span><span>{reviewed} of {state.listing?.files.length ?? commit?.file_count ?? '—'} files reviewed</span></div>
        {(commit?.parents.length || 0) > 1 && <label>Compare with parent <select aria-label="Comparison parent" value={state.parent ?? commit.parents[0]} onChange={e => void ctrl.selectCommit(state.commitId!, e.target.value)}>{commit.parents.map((parent, i) => <option key={parent} value={parent}>{i + 1}: {parent.slice(0, 8)}{i === 0 ? ' (first parent)' : ''}</option>)}</select></label>}
        <details><summary className="hgd-muted">Commit details</summary><p>{commit?.author} · {commit?.date}</p><code className="hgd-full-sha">{commit?.sha}</code></details>
      </div>
      <div className="hgd-review-body">
        <section className={`hgd-file-section ${filesOpen ? '' : 'hgd-collapsed'}`}><button className="hgd-files-toggle" aria-expanded={filesOpen} onClick={() => setFilesOpen(v => !v)}>{filesOpen ? '▾' : '▸'} Files ({state.listing?.files.length ?? '…'})</button>{filesOpen && <Files ctrl={ctrl}/>}</section>
        <DiffView ctrl={ctrl} expanded={expanded}/>
      </div>
    </>}
    {dialog && <RepositoryDialog ctrl={ctrl} hash={dialog.hash} close={() => setDialog(null)}/>}
  </div>;
}
