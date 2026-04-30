"use client";

import { ChatSession } from "@/lib/types";

interface SidebarProps {
  sessions: ChatSession[];
  activeSessionId: string;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
  onDeleteSession: (id: string) => void;
  isOpen: boolean;
  onClose: () => void;
  onSignOut: () => void;
  userName?: string;
  userImage?: string;
}

export default function Sidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewChat,
  onDeleteSession,
  isOpen,
  onClose,
  onSignOut,
  userName,
  userImage,
}: SidebarProps) {
  function formatDate(date: Date) {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) return "Bugün";
    if (days === 1) return "Dün";
    if (days < 7) return `${days} gün önce`;
    if (days < 30) return `${Math.floor(days / 7)} hafta önce`;
    return date.toLocaleDateString("tr-TR", { day: "numeric", month: "short" });
  }

  const grouped = sessions.reduce<Record<string, ChatSession[]>>(
    (acc, session) => {
      const label = formatDate(session.updatedAt);
      if (!acc[label]) acc[label] = [];
      acc[label].push(session);
      return acc;
    },
    {}
  );

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 lg:hidden" onClick={onClose} />
      )}

      <aside
        className={`
          fixed lg:static inset-y-0 left-0 z-50
          w-[280px] flex flex-col
          bg-[var(--bg-secondary)] border-r border-[var(--border)]
          transition-transform duration-300 ease-in-out
          ${isOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
        `}
      >
        {/* Header */}
        <div className="p-3 pb-2">
          <div className="flex items-center gap-2.5 px-2 mb-3">
            <div className="w-7 h-7 rounded-lg bg-[var(--accent-soft)] flex items-center justify-center">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
                <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z" />
                <path d="M14 17h7M17.5 14v7" strokeLinecap="round" />
              </svg>
            </div>
            <span className="text-sm font-semibold text-[var(--text-primary)]">Repo QA</span>
          </div>

          <button
            onClick={() => { onNewChat(); onClose(); }}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl
              border border-[var(--border-light)] hover:bg-[var(--bg-hover)] hover:border-[var(--accent)]/30
              text-[var(--text-primary)] text-sm transition-all"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Yeni Sohbet
          </button>
        </div>

        {/* Sessions */}
        <nav className="flex-1 overflow-y-auto px-2 pb-3">
          {Object.entries(grouped).map(([label, groupSessions]) => (
            <div key={label} className="mb-1">
              <h3 className="px-3 py-2 text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">
                {label}
              </h3>
              {groupSessions.map((session) => (
                <div
                  key={session.id}
                  className={`
                    group relative flex items-center rounded-xl mx-1 mb-0.5
                    ${session.id === activeSessionId
                      ? "bg-[var(--bg-active)] border border-[var(--border-light)]"
                      : "hover:bg-[var(--bg-hover)] border border-transparent"}
                  `}
                >
                  <button
                    onClick={() => { onSelectSession(session.id); onClose(); }}
                    className="flex-1 text-left px-3 py-2 min-w-0"
                  >
                    <span className="text-[13px] truncate block text-[var(--text-primary)]">
                      {session.title}
                    </span>
                  </button>

                  {sessions.length > 1 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onDeleteSession(session.id); }}
                      className="hidden group-hover:flex items-center justify-center
                        w-6 h-6 mr-1.5 rounded-md hover:bg-[var(--bg-primary)]
                        text-[var(--text-tertiary)] hover:text-[var(--danger)]
                        transition-colors"
                      aria-label="Sohbeti sil"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </nav>

        {/* User */}
        <div className="p-3 border-t border-[var(--border)]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5 min-w-0 px-1">
              {userImage ? (
                <img src={userImage} alt="" className="w-7 h-7 rounded-lg" />
              ) : (
                <div className="w-7 h-7 rounded-lg bg-[var(--accent)] flex items-center justify-center text-white text-[11px] font-bold">
                  {userName?.[0]?.toUpperCase() ?? "U"}
                </div>
              )}
              <span className="text-[13px] text-[var(--text-secondary)] truncate">
                {userName ?? "Kullanıcı"}
              </span>
            </div>
            <button
              onClick={onSignOut}
              className="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:text-[var(--danger)] transition-colors"
              aria-label="Çıkış yap"
              title="Çıkış yap"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
              </svg>
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
