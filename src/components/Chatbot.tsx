"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Message, ChatSession, ChatFolder } from "@/lib/types";
import ChatMessage from "./ChatMessage";
import ChatInput from "./ChatInput";
import Sidebar from "./Sidebar";
import RepoSelector from "./RepoSelector";
import RepoInfoCard from "./RepoInfoCard";

interface ChatbotProps {
  user: {
    id: string;
    name?: string | null;
    image?: string | null;
  };
}

export default function Chatbot({ user }: ChatbotProps) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [repoSlugs, setRepoSlugs] = useState<string[]>([]);
  const [folders, setFolders] = useState<ChatFolder[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [repoSyncing, setRepoSyncing] = useState(false);
  const [repoSyncStatus, setRepoSyncStatus] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  // Derive repo from active session
  const sessionRepo = activeSession?.repositorySlug ?? null;
  const sessionWorkspace = activeSession?.workspaceSlug ?? null;

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (activeSession) scrollToBottom();
  }, [activeSession?.messages, scrollToBottom, activeSession]);

  useEffect(() => { loadSessions(); }, []);

  // Fetch repo slugs when workspace changes
  useEffect(() => {
    if (!selectedWorkspace) { setRepoSlugs([]); return; }
    fetch(`/api/repos?workspace=${selectedWorkspace}`)
      .then((r) => r.json())
      .then((data) => setRepoSlugs((data.repos ?? []).map((r: { slug: string }) => r.slug)))
      .catch(() => {});
  }, [selectedWorkspace]);

  async function loadSessions() {
    try {
      const [sessRes, foldRes] = await Promise.all([
        fetch("/api/chat/sessions"),
        fetch("/api/chat/folders"),
      ]);
      const sessData = await sessRes.json();
      const foldData = await foldRes.json();

      setFolders((foldData.folders ?? []).map((f: { id: string; name: string }) => ({ id: f.id, name: f.name })));

      const dbSessions: ChatSession[] = (sessData.sessions ?? []).map(
        (s: { id: string; title: string; messageCount?: number; repositorySlug?: string; workspaceSlug?: string; folderId?: string; createdAt: string; updatedAt: string }) => ({
          id: s.id, title: s.title, messages: [],
          messageCount: s.messageCount ?? 0,
          repositorySlug: s.repositorySlug, workspaceSlug: s.workspaceSlug,
          folderId: s.folderId,
          createdAt: new Date(s.createdAt), updatedAt: new Date(s.updatedAt),
        })
      );

      if (dbSessions.length > 0) {
        setSessions(dbSessions);
        const first = dbSessions[0];
        setActiveSessionId(first.id);
        // Restore repo selection from session
        if (first.workspaceSlug) setSelectedWorkspace(first.workspaceSlug);
        if (first.repositorySlug) setSelectedRepo(first.repositorySlug);
        await loadSessionMessages(first.id);
      } else {
        await createNewChat(null, null);
      }
    } catch {
      await createNewChat(null, null);
    } finally {
      setInitialized(true);
    }
  }

  async function loadSessionMessages(sessionId: string) {
    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}`);
      const data = await res.json();
      if (data.session?.messages) {
        const msgs: Message[] = data.session.messages.map(
          (m: { id: string; role: string; content: string; createdAt: string }) => ({
            id: m.id, role: m.role as "user" | "assistant",
            content: m.content, timestamp: new Date(m.createdAt),
          })
        );
        setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, messages: msgs } : s)));
      }
    } catch { /* ignore */ }
  }

  async function handleSelectSession(sessionId: string) {
    setActiveSessionId(sessionId);
    const session = sessions.find((s) => s.id === sessionId);
    if (session) {
      // Restore repo selection from this session
      if (session.workspaceSlug) setSelectedWorkspace(session.workspaceSlug);
      setSelectedRepo(session.repositorySlug ?? null);
      if (session.messages.length === 0) await loadSessionMessages(sessionId);
    }
  }

  async function createNewChat(workspace: string | null, repo: string | null) {
    // Create locally first — will be persisted to DB on first message
    const localId = `local-${crypto.randomUUID()}`;
    const newSession: ChatSession = {
      id: localId,
      title: repo ?? "Yeni Sohbet",
      messages: [],
      repositorySlug: repo,
      workspaceSlug: workspace,
      folderId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    setSessions((prev) => [newSession, ...prev]);
    setActiveSessionId(localId);
    return newSession;
  }

  async function handleNewChat() {
    await createNewChat(selectedWorkspace, selectedRepo);
  }

  async function handleRepoSelect(workspace: string | null, repo: string | null) {
    setSelectedWorkspace(workspace);
    setSelectedRepo(repo);

    if (workspace && repo) {
      // Sync repo
      syncRepoWithStatus(workspace, repo);
      // Create a new chat for this repo
      await createNewChat(workspace, repo);
    }
  }

  function handleRepoClick(repoSlug: string) {
    if (selectedWorkspace) {
      handleRepoSelect(selectedWorkspace, repoSlug);
    }
  }

  async function handleDeleteSession(id: string) {
    try { await fetch(`/api/chat/sessions/${id}`, { method: "DELETE" }); } catch { /* ignore */ }
    setSessions((prev) => {
      const filtered = prev.filter((s) => s.id !== id);
      if (filtered.length === 0) { handleNewChat(); return prev; }
      if (id === activeSessionId) {
        const next = filtered[0];
        setActiveSessionId(next.id);
        if (next.workspaceSlug) setSelectedWorkspace(next.workspaceSlug);
        setSelectedRepo(next.repositorySlug ?? null);
        if (next.messages.length === 0) loadSessionMessages(next.id);
      }
      return filtered;
    });
  }

  async function handleRenameSession(id: string, title: string) {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
    try {
      await fetch(`/api/chat/sessions/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
    } catch { /* ignore */ }
  }

  async function handleCreateFolder(name: string) {
    try {
      const res = await fetch("/api/chat/folders", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      setFolders((prev) => [...prev, { id: data.folder.id, name: data.folder.name }]);
    } catch { /* ignore */ }
  }

  async function handleRenameFolder(id: string, name: string) {
    setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, name } : f)));
    try {
      await fetch(`/api/chat/folders/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
    } catch { /* ignore */ }
  }

  async function handleDeleteFolder(id: string) {
    setFolders((prev) => prev.filter((f) => f.id !== id));
    setSessions((prev) => prev.map((s) => (s.folderId === id ? { ...s, folderId: null } : s)));
    try { await fetch(`/api/chat/folders/${id}`, { method: "DELETE" }); } catch { /* ignore */ }
  }

  async function handleMoveToFolder(sessionId: string, folderId: string | null) {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, folderId } : s)));
    try {
      await fetch(`/api/chat/sessions/${sessionId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId }),
      });
    } catch { /* ignore */ }
  }

  async function syncRepoWithStatus(workspace: string, repo: string) {
    setRepoSyncing(true);
    setRepoSyncStatus("Repo bağlantısı kuruluyor...");
    const statusTimers = [
      setTimeout(() => setRepoSyncStatus("Dosya ağacı taranıyor..."), 2000),
      setTimeout(() => setRepoSyncStatus("Dosya içerikleri indiriliyor..."), 5000),
      setTimeout(() => setRepoSyncStatus("Commit geçmişi alınıyor..."), 10000),
      setTimeout(() => setRepoSyncStatus("Branch'ler senkronize ediliyor..."), 14000),
      setTimeout(() => setRepoSyncStatus("Neredeyse hazır..."), 20000),
    ];
    try {
      await fetch("/api/repos/sync", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace, repo }),
      });
      setRepoSyncStatus("Repo hazır! ✓");
      setTimeout(() => { setRepoSyncing(false); setRepoSyncStatus(""); }, 1500);
    } catch {
      setRepoSyncStatus("Senkronizasyon hatası");
      setTimeout(() => { setRepoSyncing(false); setRepoSyncStatus(""); }, 2000);
    } finally {
      statusTimers.forEach(clearTimeout);
    }
  }

  function handleStop() {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsLoading(false);
    }
  }

  async function handleRegenerate(messageId: string) {
    if (!activeSessionId || isLoading) return;
    const session = sessions.find((s) => s.id === activeSessionId);
    if (!session) return;

    // Find the message and the user message before it
    const msgIndex = session.messages.findIndex((m) => m.id === messageId);
    if (msgIndex < 1) return;

    // Remove the AI message and resend the user message before it
    const userMsg = session.messages[msgIndex - 1];
    if (userMsg.role !== "user") return;

    // Remove the AI response
    setSessions((prev) =>
      prev.map((s) => s.id === activeSessionId
        ? { ...s, messages: s.messages.filter((m) => m.id !== messageId) }
        : s
      )
    );

    // Resend
    await handleSend(userMsg.content);
  }

  async function handleSend(content: string) {
    if (!activeSessionId) return;

    let currentSessionId = activeSessionId;
    const currentSession = sessions.find((s) => s.id === currentSessionId);

    // If this is a local session (not yet in DB), persist it now
    if (currentSessionId.startsWith("local-")) {
      try {
        const res = await fetch("/api/chat/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: content.length > 40 ? content.slice(0, 40) + "…" : content,
            workspaceSlug: currentSession?.workspaceSlug ?? selectedWorkspace,
            repositorySlug: currentSession?.repositorySlug ?? selectedRepo,
          }),
        });
        const data = await res.json();
        const dbId = data.session.id;

        // Replace local session with DB session
        setSessions((prev) =>
          prev.map((s) =>
            s.id === currentSessionId
              ? { ...s, id: dbId, title: content.length > 40 ? content.slice(0, 40) + "…" : content }
              : s
          )
        );
        setActiveSessionId(dbId);
        currentSessionId = dbId;
      } catch {
        // Continue with local ID — messages won't persist but chat still works
      }
    }

    const userMessage: Message = { id: crypto.randomUUID(), role: "user", content, timestamp: new Date() };

    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== currentSessionId) return s;
        const updated = { ...s, messages: [...s.messages, userMessage], updatedAt: new Date() };
        if (s.messages.filter((m) => m.role === "user").length === 0) {
          updated.title = content.length > 40 ? content.slice(0, 40) + "…" : content;
        }
        return updated;
      })
    );

    setIsLoading(true);
    setLoadingStatus("AI yanıt hazırlıyor...");

    const botMessageId = crypto.randomUUID();

    try {
      const latestSession = sessions.find((s) => s.id === currentSessionId) ?? currentSession;
      const history = [...(latestSession?.messages ?? []), userMessage]
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content }));

      const ws = latestSession?.workspaceSlug ?? selectedWorkspace;
      const repo = latestSession?.repositorySlug ?? selectedRepo;

      // Add empty bot message for streaming
      setSessions((prev) =>
        prev.map((s) => s.id === currentSessionId
          ? { ...s, messages: [...s.messages, { id: botMessageId, role: "assistant" as const, content: "", timestamp: new Date() }] }
          : s
        )
      );

      const controller = new AbortController();
      abortControllerRef.current = controller;

      const res = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, workspaceSlug: ws, repoSlug: repo, sessionId: currentSessionId, stream: true }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = await res.json();
        setSessions((prev) =>
          prev.map((s) => s.id === currentSessionId
            ? { ...s, messages: s.messages.map((m) => m.id === botMessageId ? { ...m, content: data.error ?? "Bir hata oluştu." } : m) }
            : s
          )
        );
        return;
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) throw new Error("No reader");

      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.delta) {
              setSessions((prev) =>
                prev.map((s) => s.id === currentSessionId
                  ? { ...s, messages: s.messages.map((m) => m.id === botMessageId ? { ...m, content: m.content + data.delta } : m), updatedAt: new Date() }
                  : s
                )
              );
            }
            if (data.error) {
              setSessions((prev) =>
                prev.map((s) => s.id === currentSessionId
                  ? { ...s, messages: s.messages.map((m) => m.id === botMessageId ? { ...m, content: data.error } : m) }
                  : s
                )
              );
            }
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (err) {
      // Don't show error if user aborted
      if (err instanceof DOMException && err.name === "AbortError") {
        // Keep whatever content was streamed so far
        return;
      }
      setSessions((prev) =>
        prev.map((s) => s.id === currentSessionId
          ? { ...s, messages: s.messages.map((m) => m.id === botMessageId ? { ...m, content: m.content || "Bağlantı hatası oluştu." } : m) }
          : s
        )
      );
    } finally {
      abortControllerRef.current = null;
      setIsLoading(false);
      setLoadingStatus("");
    }
  }

  const effectiveRepo = sessionRepo ?? selectedRepo;
  const quickQuestions = effectiveRepo
    ? [
        { icon: "📁", text: "Bu repodaki dosya yapısını göster" },
        { icon: "💡", text: "Bu proje ne işe yarıyor?" },
        { icon: "📝", text: "Son commit'leri özetle" },
        { icon: "🔀", text: "Açık PR'ları listele" },
        { icon: "🌿", text: "Branch'leri listele" },
        { icon: "⚙️", text: "Kullanılan teknolojileri açıkla" },
      ]
    : [
        { icon: "📋", text: "Repoları listele" },
        { icon: "🔍", text: "Workspace bilgilerini göster" },
      ];

  if (!initialized) {
    return (
      <div className="flex items-center justify-center h-full bg-[var(--bg-primary)]">
        <div className="flex items-center gap-3 text-[var(--text-secondary)]">
          <svg className="animate-spin w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          Yükleniyor...
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <Sidebar
        sessions={sessions} folders={folders}
        activeSessionId={activeSessionId ?? ""}
        onSelectSession={handleSelectSession}
        onNewChat={handleNewChat}
        onDeleteSession={handleDeleteSession}
        onRenameSession={handleRenameSession}
        onCreateFolder={handleCreateFolder}
        onRenameFolder={handleRenameFolder}
        onDeleteFolder={handleDeleteFolder}
        onMoveToFolder={handleMoveToFolder}
        isOpen={sidebarOpen}
        isCollapsed={sidebarCollapsed}
        onClose={() => setSidebarOpen(false)}
        onSignOut={() => { window.location.href = "/api/auth/signout"; }}
        userName={user.name ?? undefined}
        userImage={user.image ?? undefined}
      />

      <main className="flex-1 flex flex-col min-w-0 bg-[var(--bg-primary)]">
        {/* Header */}
        <header className="flex items-center justify-between h-13 px-4 border-b border-[var(--border)] bg-[var(--bg-secondary)]/50 backdrop-blur-sm">
          <div className="flex items-center gap-2 min-w-0">
            {/* Mobile: open sidebar overlay */}
            <button
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] transition-colors"
              aria-label="Menüyü aç"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M3 12h18M3 6h18M3 18h18" />
              </svg>
            </button>
            {/* Desktop: toggle sidebar */}
            <button
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="hidden lg:flex p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] transition-colors"
              aria-label={sidebarCollapsed ? "Sidebar'ı aç" : "Sidebar'ı kapat"}
              title={sidebarCollapsed ? "Sidebar'ı aç" : "Sidebar'ı kapat"}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                {sidebarCollapsed
                  ? <path d="M3 12h18M3 6h18M3 18h18" />
                  : <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /></>
                }
              </svg>
            </button>
            <div className="min-w-0">
              <h2 className="text-[13px] font-medium text-[var(--text-primary)] truncate">
                {activeSession?.title ?? "Yeni Sohbet"}
              </h2>
              {effectiveRepo && selectedWorkspace && (
                <RepoInfoCard workspace={selectedWorkspace} repo={effectiveRepo} />
              )}
              {effectiveRepo && !selectedWorkspace && (
                <p className="text-[11px] text-[var(--accent)] truncate">{effectiveRepo}</p>
              )}
            </div>
          </div>
          <RepoSelector
            selectedWorkspace={selectedWorkspace}
            selectedRepo={selectedRepo}
            onSelect={handleRepoSelect}
          />
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          {repoSyncing && (
            <div className="mx-4 mt-3 mb-1">
              <div className="max-w-3xl mx-auto">
                <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[var(--accent-soft)] border border-[var(--accent)]/20">
                  <svg className="animate-spin flex-shrink-0 w-4 h-4 text-[var(--accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-[var(--accent)]">{selectedRepo} analiz ediliyor</p>
                    <p className="text-[12px] text-[var(--accent)]/70">{repoSyncStatus}</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {!activeSession || activeSession.messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full px-4">
              <div className="w-16 h-16 rounded-2xl bg-[var(--accent-soft)] flex items-center justify-center mb-6">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5">
                  <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z" />
                  <path d="M14 17h7M17.5 14v7" strokeLinecap="round" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-[var(--text-primary)] mb-2">
                {effectiveRepo ? effectiveRepo : "Repo QA Assistant"}
              </h3>
              <p className="text-sm text-[var(--text-tertiary)] text-center max-w-md mb-8 leading-relaxed">
                {effectiveRepo
                  ? "Bu sohbet bu repoya özeldir. Aşağıdaki sorulardan birini deneyin veya kendi sorunuzu yazın."
                  : "Sağ üstten bir repo seçin — her repo için ayrı bir sohbet açılır."}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-lg w-full">
                {quickQuestions.map((q) => (
                  <button key={q.text} onClick={() => handleSend(q.text)}
                    className="flex items-center gap-3 text-left px-4 py-3 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]/50 hover:bg-[var(--bg-hover)] hover:border-[var(--border-light)] text-[13px] text-[var(--text-secondary)] transition-all">
                    <span className="text-base">{q.icon}</span>{q.text}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div>
              {activeSession.messages.map((msg, idx) => (
                <ChatMessage
                  key={msg.id}
                  message={msg}
                  repoSlugs={repoSlugs}
                  onRepoClick={handleRepoClick}
                  onRegenerate={handleRegenerate}
                  isLast={idx === activeSession.messages.length - 1}
                  isStreaming={isLoading && idx === activeSession.messages.length - 1}
                />
              ))}
              <div ref={messagesEndRef} className="h-4" />
            </div>
          )}
        </div>

        <ChatInput onSend={handleSend} onStop={handleStop} disabled={isLoading && !abortControllerRef.current} isStreaming={isLoading} repoSelected={!!effectiveRepo} />
      </main>
    </div>
  );
}
