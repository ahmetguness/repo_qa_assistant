"use client";

import { useEffect, useState, useRef } from "react";
import { ChatSession, ChatFolder } from "@/lib/types";
import { useLanguage } from "./LanguageProvider";

interface SidebarProps {
  sessions: ChatSession[];
  folders: ChatFolder[];
  activeSessionId: string;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onCreateFolder: (name: string) => void;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  onMoveToFolder: (sessionId: string, folderId: string | null) => void;
  isOpen: boolean;
  isCollapsed?: boolean;
  onClose: () => void;
  onSignOut: () => void;
  userName?: string;
  userImage?: string;
}

export default function Sidebar({
  sessions,
  folders,
  activeSessionId,
  onSelectSession,
  onNewChat,
  onDeleteSession,
  onRenameSession,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveToFolder,
  isOpen,
  isCollapsed,
  onClose,
  onSignOut,
  userName,
  userImage,
}: SidebarProps) {
  const { t, language } = useLanguage();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [openFolders, setOpenFolders] = useState<Set<string>>(
    new Set(folders.map((f) => f.id)),
  );
  const [contextMenu, setContextMenu] = useState<{
    id: string;
    type: "session" | "folder" | "blank";
    x: number;
    y: number;
  } | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{
    id: string;
    type: "folder" | "session";
    name: string;
    count: number;
  } | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const newFolderRef = useRef<HTMLInputElement>(null);
  const dragSessionId = useRef<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  function toggleFolder(id: string) {
    setOpenFolders((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function startEdit(id: string, val: string) {
    setEditingId(id);
    setEditValue(val);
  }

  function commitEdit(id: string, type: "session" | "folder") {
    const t = editValue.trim();
    if (t) {
      if (type === "session") onRenameSession(id, t);
      else onRenameFolder(id, t);
    }
    setEditingId(null);
  }

  function startCreateFolder() {
    setCreatingFolder(true);
    setNewFolderName("");
    setTimeout(() => newFolderRef.current?.focus(), 50);
  }

  function commitCreateFolder() {
    const name = newFolderName.trim();
    if (name) onCreateFolder(name);
    setCreatingFolder(false);
    setNewFolderName("");
  }

  function handleContextMenu(
    e: React.MouseEvent,
    id: string,
    type: "session" | "folder",
  ) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ id, type, x: e.clientX, y: e.clientY });
  }

  // Drag handlers
  function onDragStart(e: React.DragEvent, sessionId: string) {
    dragSessionId.current = sessionId;
    e.dataTransfer.effectAllowed = "move";
    (e.target as HTMLElement).style.opacity = "0.5";
  }

  function onDragEnd(e: React.DragEvent) {
    dragSessionId.current = null;
    setDragOverFolderId(null);
    (e.target as HTMLElement).style.opacity = "1";
  }

  function onFolderDragOver(e: React.DragEvent, folderId: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverFolderId(folderId);
  }

  function onFolderDragLeave() {
    setDragOverFolderId(null);
  }

  function onFolderDrop(e: React.DragEvent, folderId: string) {
    e.preventDefault();
    setDragOverFolderId(null);
    if (dragSessionId.current) {
      onMoveToFolder(dragSessionId.current, folderId);
      // Open the folder
      setOpenFolders((prev) => new Set([...prev, folderId]));
    }
    dragSessionId.current = null;
  }

  function onNavDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOverFolderId(null);
    if (dragSessionId.current) onMoveToFolder(dragSessionId.current, null);
    dragSessionId.current = null;
  }

  // Visible sessions (filter by search + hide empty)
  const searchLower = searchQuery.toLowerCase();
  const visibleSessions = sessions.filter((s) => {
    const hasContent =
      s.messages.length > 0 ||
      (s.messageCount ?? 0) > 0 ||
      s.id === activeSessionId;
    if (!hasContent) return false;
    if (!searchQuery) return true;
    return (
      s.title.toLowerCase().includes(searchLower) ||
      (s.repositorySlug?.toLowerCase().includes(searchLower) ?? false)
    );
  });

  const folderedSessions = new Map<string, ChatSession[]>();
  const unfiledSessions: ChatSession[] = [];
  for (const s of visibleSessions) {
    if (s.folderId) {
      const a = folderedSessions.get(s.folderId) ?? [];
      a.push(s);
      folderedSessions.set(s.folderId, a);
    } else unfiledSessions.push(s);
  }

  function formatDate(date: Date) {
    const days = Math.max(0, Math.floor((now - date.getTime()) / 86400000));
    if (days === 0) return t("today");
    if (days === 1) return t("yesterday");
    if (days < 7) return `${days} ${t("daysAgo")}`;
    if (days < 30) return `${Math.floor(days / 7)} ${t("weeksAgo")}`;
    return date.toLocaleDateString(language === "tr" ? "tr-TR" : "en-US", {
      day: "numeric",
      month: "short",
    });
  }

  const dateGroups = unfiledSessions.reduce<Record<string, ChatSession[]>>(
    (acc, s) => {
      const l = formatDate(s.updatedAt);
      (acc[l] ??= []).push(s);
      return acc;
    },
    {},
  );

  function renderSessionItem(session: ChatSession) {
    const isActive = session.id === activeSessionId;
    const isEditing = editingId === session.id;

    return (
      <div
        key={session.id}
        data-ctx="session"
        draggable={!isEditing}
        onDragStart={(e) => onDragStart(e, session.id)}
        onDragEnd={onDragEnd}
        onContextMenu={(e) => handleContextMenu(e, session.id, "session")}
        className={`group relative flex items-center rounded-xl mx-1 mb-0.5 cursor-grab active:cursor-grabbing ${
          isActive
            ? "bg-[var(--bg-active)] border border-[var(--border-light)]"
            : "hover:bg-[var(--bg-hover)] border border-transparent"
        }`}
      >
        <button
          onClick={() => {
            onSelectSession(session.id);
            onClose();
          }}
          onDoubleClick={() => startEdit(session.id, session.title)}
          className="flex-1 text-left px-3 py-2 min-w-0"
        >
          {isEditing ? (
            <input
              autoFocus
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={() => commitEdit(session.id, "session")}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitEdit(session.id, "session");
                if (e.key === "Escape") setEditingId(null);
              }}
              className="w-full bg-transparent text-[13px] text-[var(--text-primary)] outline-none border-b border-[var(--accent)]"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <>
              {session.repositorySlug && (
                <span className="flex items-center gap-1 text-[10px] text-[var(--accent)]/70 truncate mb-0.5">
                  {session.workspaceSlug === "github" ? (
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      className="flex-shrink-0 text-[var(--text-tertiary)]"
                    >
                      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                    </svg>
                  ) : (
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="flex-shrink-0"
                    >
                      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
                    </svg>
                  )}
                  {session.repositorySlug}
                </span>
              )}
              <span className="text-[13px] truncate block text-[var(--text-primary)]">
                {session.title}
              </span>
            </>
          )}
        </button>
        {!isEditing && (
          <div className="hidden group-hover:flex items-center gap-0.5 mr-1.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                startEdit(session.id, session.title);
              }}
              className="w-6 h-6 rounded-md flex items-center justify-center hover:bg-[var(--bg-primary)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
              title={t("rename")}
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDeleteSession(session.id);
              }}
              className="w-6 h-6 rounded-md flex items-center justify-center hover:bg-[var(--bg-primary)] text-[var(--text-tertiary)] hover:text-[var(--danger)] transition-colors"
              title={t("delete")}
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      {contextMenu && (
        <>
          <div
            className="fixed inset-0 z-[60]"
            onClick={() => setContextMenu(null)}
          />
          <div
            className="fixed z-[61] w-48 bg-[var(--bg-secondary)] border border-[var(--border-light)] rounded-xl shadow-2xl shadow-black/30 py-1"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {contextMenu.type === "blank" && (
              <>
                <button
                  onClick={() => {
                    onNewChat();
                    setContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-2 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  {t("newChat")}
                </button>
                <button
                  onClick={() => {
                    startCreateFolder();
                    setContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-2 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    <path d="M12 11v6M9 14h6" strokeLinecap="round" />
                  </svg>
                  {t("newFolder")}
                </button>
              </>
            )}
            {contextMenu.type === "session" && (
              <>
                <button
                  onClick={() => {
                    startEdit(
                      contextMenu.id,
                      sessions.find((s) => s.id === contextMenu.id)?.title ??
                        "",
                    );
                    setContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-2 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
                >
                  ✏️ {t("rename")}
                </button>
                {folders.length > 0 && (
                  <>
                    <div className="border-t border-[var(--border)] my-1" />
                    <p className="px-3 py-1 text-[11px] text-[var(--text-tertiary)]">
                      {t("moveToFolder")}
                    </p>
                    {folders.map((f) => (
                      <button
                        key={f.id}
                        onClick={() => {
                          onMoveToFolder(contextMenu.id, f.id);
                          setContextMenu(null);
                        }}
                        className="w-full text-left px-3 py-1.5 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
                      >
                        📁 {f.name}
                      </button>
                    ))}
                    <button
                      onClick={() => {
                        onMoveToFolder(contextMenu.id, null);
                        setContextMenu(null);
                      }}
                      className="w-full text-left px-3 py-1.5 text-[13px] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] transition-colors"
                    >
                      {t("removeFromFolder")}
                    </button>
                  </>
                )}
                <div className="border-t border-[var(--border)] my-1" />
                <button
                  onClick={() => {
                    onDeleteSession(contextMenu.id);
                    setContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-2 text-[13px] text-[var(--danger)] hover:bg-[var(--bg-hover)] transition-colors"
                >
                  🗑️ {t("delete")}
                </button>
              </>
            )}
            {contextMenu.type === "folder" && (
              <>
                <button
                  onClick={() => {
                    startEdit(
                      contextMenu.id,
                      folders.find((f) => f.id === contextMenu.id)?.name ?? "",
                    );
                    setContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-2 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
                >
                  ✏️ {t("rename")}
                </button>
                <button
                  onClick={() => {
                    const folderSess =
                      folderedSessions.get(contextMenu.id) ?? [];
                    if (folderSess.length > 0) {
                      const folder = folders.find(
                        (f) => f.id === contextMenu.id,
                      );
                      setConfirmDelete({
                        id: contextMenu.id,
                        type: "folder",
                        name: folder?.name ?? t("newFolder"),
                        count: folderSess.length,
                      });
                    } else {
                      onDeleteFolder(contextMenu.id);
                    }
                    setContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-2 text-[13px] text-[var(--danger)] hover:bg-[var(--bg-hover)] transition-colors"
                >
                  🗑️ {t("deleteFolder")}
                </button>
              </>
            )}
          </div>
        </>
      )}

      {/* Confirm delete dialog */}
      {confirmDelete && (
        <>
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[70]"
            onClick={() => setConfirmDelete(null)}
          />
          <div className="fixed z-[71] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 bg-[var(--bg-secondary)] border border-[var(--border-light)] rounded-2xl shadow-2xl shadow-black/40 p-5">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-[var(--danger)]/10 flex items-center justify-center">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--danger)"
                  strokeWidth="2"
                >
                  <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14" />
                </svg>
              </div>
              <div>
                <p className="text-[14px] font-medium text-[var(--text-primary)]">
                  {t("deleteFolderQuestion")}
                </p>
                <p className="text-[12px] text-[var(--text-tertiary)]">
                  {confirmDelete.name}
                </p>
              </div>
            </div>
            <p className="text-[13px] text-[var(--text-secondary)] mb-5 leading-relaxed">
              {t("folderDeleteMessageStart")}{" "}
              <span className="font-semibold text-[var(--text-primary)]">
                {confirmDelete.count}
              </span>{" "}
              {t("folderDeleteMessageEnd")}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className="flex-1 px-3 py-2 rounded-xl text-[13px] text-[var(--text-secondary)] border border-[var(--border-light)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                {t("cancel")}
              </button>
              <button
                onClick={() => {
                  onDeleteFolder(confirmDelete.id);
                  setConfirmDelete(null);
                }}
                className="flex-1 px-3 py-2 rounded-xl text-[13px] text-white bg-[var(--danger)] hover:opacity-90 transition-colors"
              >
                {t("delete")}
              </button>
            </div>
          </div>
        </>
      )}

      <aside
        onContextMenu={(e) => {
          const t = e.target as HTMLElement;
          if (!t.closest("[data-ctx]")) {
            e.preventDefault();
            setContextMenu({
              id: "",
              type: "blank",
              x: e.clientX,
              y: e.clientY,
            });
          }
        }}
        className={`fixed lg:static inset-y-0 left-0 z-50 w-[280px] flex flex-col bg-[var(--bg-secondary)] border-r border-[var(--border)] transition-all duration-300 ease-in-out ${isOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"} ${isCollapsed ? "lg:hidden" : ""}`}
      >
        <div className="p-3 pb-2">
          <div className="flex items-center gap-2.5 px-2 mb-3">
            <div className="w-7 h-7 rounded-lg bg-[var(--accent-soft)] flex items-center justify-center">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--accent)"
                strokeWidth="2"
              >
                <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z" />
                <path d="M14 17h7M17.5 14v7" strokeLinecap="round" />
              </svg>
            </div>
            <span className="text-sm font-semibold text-[var(--text-primary)]">
              Repo QA
            </span>
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={() => {
                onNewChat();
                onClose();
              }}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-xl border border-[var(--border-light)] hover:bg-[var(--bg-hover)] hover:border-[var(--accent)]/30 text-[var(--text-primary)] text-[13px] transition-all"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              {t("newChat")}
            </button>
            <button
              onClick={startCreateFolder}
              className="px-2.5 py-2 rounded-xl border border-[var(--border-light)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-all"
              title={t("newFolder")}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                <path d="M12 11v6M9 14h6" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          {/* Search */}
          <div className="mt-2 relative">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--text-tertiary)"
              strokeWidth="2"
              className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("searchChats")}
              className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-[var(--bg-tertiary)] border border-transparent
                focus:border-[var(--border-light)] text-[12px] text-[var(--text-primary)]
                placeholder:text-[var(--text-tertiary)] outline-none transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <nav
          className="flex-1 overflow-y-auto px-2 pb-3"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={onNavDrop}
        >
          {/* New folder input */}
          {creatingFolder && (
            <div className="flex items-center gap-1.5 px-2 py-1.5 mx-1 mb-1 rounded-lg bg-[var(--bg-hover)] border border-[var(--accent)]/30">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--warning)"
                strokeWidth="1.5"
              >
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <input
                ref={newFolderRef}
                autoFocus
                value={newFolderName}
                placeholder={t("folderNamePlaceholder")}
                onChange={(e) => setNewFolderName(e.target.value)}
                onBlur={() => {
                  if (newFolderName.trim()) commitCreateFolder();
                  else setCreatingFolder(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitCreateFolder();
                  if (e.key === "Escape") setCreatingFolder(false);
                }}
                className="flex-1 bg-transparent text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
              />
            </div>
          )}

          {/* Folders */}
          {folders.map((folder) => {
            const folderSessions = folderedSessions.get(folder.id) ?? [];
            const isFolderOpen = openFolders.has(folder.id);
            const isEditingFolder = editingId === folder.id;
            const isDragOver = dragOverFolderId === folder.id;

            return (
              <div key={folder.id} className="mb-1">
                <div
                  data-ctx="folder"
                  onContextMenu={(e) =>
                    handleContextMenu(e, folder.id, "folder")
                  }
                  onDragOver={(e) => onFolderDragOver(e, folder.id)}
                  onDragLeave={onFolderDragLeave}
                  onDrop={(e) => onFolderDrop(e, folder.id)}
                  className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg cursor-pointer group transition-all ${
                    isDragOver
                      ? "bg-[var(--accent-soft)] border border-[var(--accent)]/30 scale-[1.02]"
                      : "hover:bg-[var(--bg-hover)] border border-transparent"
                  }`}
                  onClick={() => toggleFolder(folder.id)}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--text-tertiary)"
                    strokeWidth="2"
                    className={`transition-transform ${isFolderOpen ? "rotate-90" : ""}`}
                  >
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={isDragOver ? "var(--accent)" : "var(--warning)"}
                    strokeWidth="1.5"
                  >
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                  {isEditingFolder ? (
                    <input
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => commitEdit(folder.id, "folder")}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitEdit(folder.id, "folder");
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="flex-1 bg-transparent text-[12px] text-[var(--text-primary)] outline-none border-b border-[var(--accent)]"
                    />
                  ) : (
                    <span className="text-[12px] font-medium text-[var(--text-secondary)] truncate">
                      {folder.name}
                    </span>
                  )}
                  <span className="text-[10px] text-[var(--text-tertiary)] ml-auto">
                    {folderSessions.length}
                  </span>
                </div>
                {isFolderOpen && (
                  <div className="ml-3">
                    {folderSessions.map(renderSessionItem)}
                  </div>
                )}
              </div>
            );
          })}

          {/* Unfiled sessions */}
          {Object.entries(dateGroups).map(([label, groupSessions]) => (
            <div key={label} className="mb-1">
              <h3 className="px-3 py-2 text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">
                {label}
              </h3>
              {groupSessions.map(renderSessionItem)}
            </div>
          ))}
        </nav>

        <div className="p-3 border-t border-[var(--border)]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5 min-w-0 px-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {userImage ? (
                <img src={userImage} alt="" className="w-7 h-7 rounded-lg" />
              ) : (
                <div className="w-7 h-7 rounded-lg bg-[var(--accent)] flex items-center justify-center text-white text-[11px] font-bold">
                  {userName?.[0]?.toUpperCase() ?? "U"}
                </div>
              )}
              <span className="text-[13px] text-[var(--text-secondary)] truncate">
                {userName ?? t("userFallback")}
              </span>
            </div>
            <button
              onClick={onSignOut}
              className="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:text-[var(--danger)] transition-colors"
              title="Çıkış yap"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
              </svg>
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
