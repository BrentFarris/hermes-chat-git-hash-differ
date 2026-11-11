import React, { useLayoutEffect, useRef, useState } from 'react';
import { Button, Input, Popover, PopoverContent, PopoverTrigger } from '@hermes/plugin-sdk';
import { ReviewController } from './controller';
import { Styles, useReview, VirtualList } from './review';
import type { Commit } from './types';

const complete = (commit: Commit) => commit.file_count !== null && commit.reviewed_count === commit.file_count;
const progress = (commit: Commit) => `${commit.reviewed_count || 0} of ${commit.file_count ?? 'unknown'} files reviewed`;
const description = (commit: Commit) => `${commit.sha}\n${commit.subject}\n${commit.repo_name} · ${progress(commit)}`;

export function CommitStrip({ ctrl, open }: { ctrl: ReviewController; open(commitId?: string, resume?: boolean): void }) {
  const state = useReview(ctrl);
  const strip = useRef<HTMLDivElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const picked = useRef(false);
  const [limit, setLimit] = useState(3);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  useLayoutEffect(() => {
    if (!strip.current) return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width || 0;
      setLimit(width >= 790 ? 3 : width >= 620 ? 2 : width >= 440 ? 1 : 0);
    });
    observer.observe(strip.current);
    return () => observer.disconnect();
  }, []);
  const commits = state.snapshot?.commits || [];
  const filtered = commits.filter(c => `${c.sha} ${c.subject} ${c.repo_name}`.toLowerCase().includes(query.trim().toLowerCase()));
  const recent = commits.slice(0, limit);
  const remaining = commits.length - recent.length;
  const title = state.snapshot?.session.title || 'Untitled chat';
  const resume = ctrl.resumeTarget;
  const resumedCommit = commits.find(c => c.id === resume?.commitId);
  const choose = (commit: Commit) => { picked.current = true; setPickerOpen(false); open(commit.id); };
  if (!commits.length || !ctrl.showChips) return null;
  return <div ref={strip} className="hgd hgd-commit-strip" role="region" aria-label={`Commits for ${title} (focused chat)`}>
    <Styles/>
    <Button variant="ghost" size="xs" className="hgd-chip hgd-commit-count" title={`Review commits in the focused chat: ${title}`} onClick={() => open()}>
      Commits · {commits.length}{ctrl.newCount > 0 && <span className="hgd-new">{ctrl.newCount} new</span>}
    </Button>
    {recent.map(commit => <Button key={commit.id} variant="ghost" size="xs" className="hgd-chip hgd-hash-chip"
      aria-label={`Review ${commit.sha.slice(0, 8)}: ${commit.subject}${complete(commit) ? ' (reviewed)' : ''}`}
      title={description(commit)} onClick={() => choose(commit)}>
      {complete(commit) && <span aria-hidden="true">✓</span>}<code>{commit.sha.slice(0, 8)}</code>
      <span className="hgd-chip-subject">{commit.subject}</span>{ctrl.isNew(commit.id) && <span className="hgd-new">New</span>}
    </Button>)}
    {/* Contain search focus while open, including the composer's focus restoration after a pane closes. */}
    {remaining > 0 && <Popover modal open={pickerOpen} onOpenChange={(value: boolean) => { picked.current = false; setPickerOpen(value); if (value) setQuery(''); }}>
      <PopoverTrigger asChild><Button variant="ghost" size="xs" className="hgd-chip" aria-label={`Find a commit (${remaining} more)`} title="Search all commits by hash, subject or repository">+{remaining}</Button></PopoverTrigger>
      <PopoverContent side="top" align="start" collisionPadding={12} className="hgd hgd-commit-picker" aria-label={`Find a commit in ${title}`}
        onCloseAutoFocus={(event: Event) => { if (picked.current) event.preventDefault(); }}>
        <Styles/>
        <div className="hgd-picker-heading"><strong>Session commits</strong><span className="hgd-muted">{commits.length}</span></div>
        <p className="hgd-picker-chat" title={title}>Focused chat: {title}</p>
        <Input aria-label="Find a session commit" placeholder="Hash, subject or repository…" value={query}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
          onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); results.current?.querySelector<HTMLButtonElement>('button')?.focus(); }
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && filtered.length === 1) { event.preventDefault(); choose(filtered[0]); }
          }}/>
        <div className="hgd-picker-results" ref={results}>
          <VirtualList key={query} items={filtered} height={70} label="Matching commits" render={commit => <button className="hgd-picker-result" title={description(commit)} onClick={() => choose(commit)}>
            <div className="hgd-row"><code>{commit.sha.slice(0, 8)}</code>{complete(commit) && <span>✓ Reviewed</span>}{ctrl.isNew(commit.id) && <span className="hgd-new">New</span>}</div>
            <strong>{commit.subject}</strong><small>{commit.repo_name} · {progress(commit)}</small>
          </button>}/>
          {!filtered.length && <p className="hgd-empty">No matching commits.</p>}
        </div>
      </PopoverContent>
    </Popover>}
    {resumedCommit && <Button variant="ghost" size="xs" className="hgd-chip hgd-resume" aria-label="Resume review"
      title={`Resume ${resumedCommit.sha.slice(0, 8)}: ${resumedCommit.subject} — last file and scroll position`} onClick={() => open(undefined, true)}>Resume review</Button>}
  </div>;
}
