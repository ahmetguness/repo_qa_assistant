"use client";

import { useState, useEffect } from "react";

interface RepoInfo {
  slug: string;
  name: string;
  description?: string;
  language?: string;
  isPrivate: boolean;
  lastSyncedAt?: string;
}

interface RepoInfoCardProps {
  workspace: string;
  repo: string;
}

export default function RepoInfoCard({ workspace, repo }: RepoInfoCardProps) {
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [stats, setStats] = useState<{ files: number; branches: number; commits: number } | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    // Fetch repo info
    fetch(`/api/repos?workspace=${workspace}`)
      .then((r) => r.json())
      .then((data) => {
        const found = (data.repos ?? []).find((r: RepoInfo) => r.slug === repo);
        if (found) setInfo(found);
      })
      .catch(() => {});

    // Fetch stats
    fetch(`/api/repos/stats?workspace=${workspace}&repo=${repo}`)
      .then((r) => r.json())
      .then((data) => setStats(data))
      .catch(() => {});
  }, [isOpen, workspace, repo]);

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="text-[11px] text-[var(--accent)] hover:text-[var(--accent-hover)] truncate transition-colors cursor-pointer"
      >
        {repo}
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setIsOpen(false)} />
          <div className="absolute top-full left-0 mt-1 w-72 z-40 bg-[var(--bg-secondary)] border border-[var(--border-light)] rounded-xl shadow-2xl shadow-black/30 p-4">
            <div className="flex items-start gap-3 mb-3">
              <div className="w-9 h-9 rounded-lg bg-[var(--accent-soft)] flex items-center justify-center flex-shrink-0">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
                  <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
                </svg>
              </div>
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-[var(--text-primary)] truncate">{workspace}/{repo}</p>
                {info?.description && (
                  <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5 line-clamp-2">{info.description}</p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 mb-3">
              {info?.language && (
                <div className="px-2 py-1.5 rounded-lg bg-[var(--bg-tertiary)] text-center">
                  <p className="text-[10px] text-[var(--text-tertiary)]">Dil</p>
                  <p className="text-[12px] text-[var(--text-primary)] font-medium">{info.language}</p>
                </div>
              )}
              {stats && (
                <>
                  <div className="px-2 py-1.5 rounded-lg bg-[var(--bg-tertiary)] text-center">
                    <p className="text-[10px] text-[var(--text-tertiary)]">Dosya</p>
                    <p className="text-[12px] text-[var(--text-primary)] font-medium">{stats.files}</p>
                  </div>
                  <div className="px-2 py-1.5 rounded-lg bg-[var(--bg-tertiary)] text-center">
                    <p className="text-[10px] text-[var(--text-tertiary)]">Branch</p>
                    <p className="text-[12px] text-[var(--text-primary)] font-medium">{stats.branches}</p>
                  </div>
                </>
              )}
            </div>

            {info?.lastSyncedAt && (
              <p className="text-[10px] text-[var(--text-tertiary)]">
                Son sync: {new Date(info.lastSyncedAt).toLocaleString("tr-TR")}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
