"use client";

import { useState, useEffect } from "react";

interface Workspace {
  id: string;
  slug: string;
  name: string;
}

interface Repo {
  id: string;
  slug: string;
  name: string;
  description?: string;
  language?: string;
  isPrivate: boolean;
}

interface RepoSelectorProps {
  selectedWorkspace: string | null;
  selectedRepo: string | null;
  onSelect: (workspace: string | null, repo: string | null) => void;
}

export default function RepoSelector({ selectedWorkspace, selectedRepo, onSelect }: RepoSelectorProps) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loadingWs, setLoadingWs] = useState(false);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => { loadWorkspaces(); }, []);
  useEffect(() => { if (selectedWorkspace) loadRepos(selectedWorkspace); }, [selectedWorkspace]);

  async function loadWorkspaces() {
    setLoadingWs(true);
    try {
      const res = await fetch("/api/workspaces");
      const data = await res.json();
      setWorkspaces(data.workspaces ?? []);
      if (data.workspaces?.length === 1 && !selectedWorkspace) {
        onSelect(data.workspaces[0].slug, null);
      }
    } catch { /* ignore */ } finally { setLoadingWs(false); }
  }

  async function loadRepos(workspace: string) {
    setLoadingRepos(true);
    try {
      const res = await fetch(`/api/repos?workspace=${workspace}`);
      const data = await res.json();
      setRepos(data.repos ?? []);
    } catch { /* ignore */ } finally { setLoadingRepos(false); }
  }

  async function handleRepoSelect(repoSlug: string) {
    if (!selectedWorkspace) return;
    onSelect(selectedWorkspace, repoSlug);
    setIsOpen(false);
  }

  const selectedRepoData = repos.find((r) => r.slug === selectedRepo);

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-all ${
          selectedRepo
            ? "bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[var(--accent-soft)]"
            : "hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]"
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
        </svg>
        <span className="max-w-[200px] truncate">
          {selectedRepo ? (selectedRepoData?.name ?? selectedRepo) : "Repo seçin"}
        </span>
        {syncing && (
          <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        )}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setIsOpen(false)} />
          <div className="absolute top-full right-0 mt-2 w-80 max-h-[420px] overflow-y-auto z-40
            bg-[var(--bg-secondary)] border border-[var(--border-light)] rounded-xl shadow-2xl shadow-black/30">

            {workspaces.length > 1 && (
              <div className="p-2 border-b border-[var(--border)]">
                <p className="text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider px-2 py-1.5">
                  Workspace
                </p>
                {workspaces.map((ws) => (
                  <button
                    key={ws.id}
                    onClick={() => onSelect(ws.slug, null)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                      selectedWorkspace === ws.slug
                        ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                        : "hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]"
                    }`}
                  >
                    {ws.name}
                  </button>
                ))}
              </div>
            )}

            <div className="p-2">
              <p className="text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider px-2 py-1.5">
                Repolar {loadingRepos && <span className="normal-case font-normal">yükleniyor...</span>}
              </p>

              {loadingWs || loadingRepos ? (
                <div className="px-3 py-6 text-center text-sm text-[var(--text-tertiary)]">
                  <svg className="animate-spin w-5 h-5 mx-auto mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  Yükleniyor...
                </div>
              ) : repos.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-[var(--text-tertiary)]">
                  {selectedWorkspace ? "Repo bulunamadı" : "Önce bir workspace seçin"}
                </div>
              ) : (
                repos.map((repo) => (
                  <button
                    key={repo.id}
                    onClick={() => handleRepoSelect(repo.slug)}
                    className={`w-full text-left px-3 py-2.5 rounded-lg transition-all ${
                      selectedRepo === repo.slug
                        ? "bg-[var(--accent-soft)] border border-[var(--accent)]/20"
                        : "hover:bg-[var(--bg-hover)] border border-transparent"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={selectedRepo === repo.slug ? "var(--accent)" : "var(--text-tertiary)"} strokeWidth="1.5">
                        <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
                      </svg>
                      <span className={`text-sm ${selectedRepo === repo.slug ? "text-[var(--accent)] font-medium" : "text-[var(--text-primary)]"}`}>
                        {repo.name}
                      </span>
                      {repo.isPrivate && (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2">
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                      )}
                      {repo.language && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]">
                          {repo.language}
                        </span>
                      )}
                    </div>
                    {repo.description && (
                      <p className="text-[11px] text-[var(--text-tertiary)] mt-1 truncate pl-5">
                        {repo.description}
                      </p>
                    )}
                  </button>
                ))
              )}
            </div>

            {selectedRepo && (
              <div className="p-2 border-t border-[var(--border)]">
                <button
                  onClick={() => { onSelect(selectedWorkspace, null); setIsOpen(false); }}
                  className="w-full text-left px-3 py-2 rounded-lg text-[13px]
                    hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] transition-colors"
                >
                  ✕ Seçimi kaldır
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
