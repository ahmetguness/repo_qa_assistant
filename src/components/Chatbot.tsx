"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Message, ChatSession, ChatFolder } from "@/lib/types";
import ChatMessage from "./ChatMessage";
import ChatInput from "./ChatInput";
import Sidebar from "./Sidebar";
import RepoSelector from "./RepoSelector";
import RepoInfoCard from "./RepoInfoCard";
import GitHubInput from "./GitHubInput";

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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [repoSlugs, setRepoSlugs] = useState<string[]>([]);
  const [folders, setFolders] = useState<ChatFolder[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [repoSyncing, setRepoSyncing] = useState(false);
  const [repoSyncStatus, setRepoSyncStatus] = useState("");
  const [syncProgress, setSyncProgress] = useState(0);
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const instantScrollSessionRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const syncAbortRef = useRef<AbortController | null>(null);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  // Derive repo from active session
  const sessionRepo = activeSession?.repositorySlug ?? null;
  const sessionWorkspace = activeSession?.workspaceSlug ?? null;
  const activeMessageCount = activeSession?.messages.length ?? 0;
  const activeLastMessageContent = activeSession?.messages.at(-1)?.content ?? "";

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    requestAnimationFrame(() => {
      const viewport = messagesViewportRef.current;
      if (viewport) {
        viewport.scrollTo({ top: viewport.scrollHeight, behavior });
        return;
      }
      messagesEndRef.current?.scrollIntoView({ behavior, block: "end" });
    });
  }, []);

  useEffect(() => {
    if (!activeSession || !stickToBottomRef.current) return;
    const shouldScrollInstantly = instantScrollSessionRef.current === activeSession.id;
    scrollToBottom(isLoading || shouldScrollInstantly ? "auto" : "smooth");
    if (shouldScrollInstantly && activeMessageCount > 0) {
      instantScrollSessionRef.current = null;
    }
  }, [activeMessageCount, activeLastMessageContent, isLoading, scrollToBottom, activeSession]);

  function handleMessagesScroll() {
    const el = messagesViewportRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  // Initial session hydration should run once on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadSessions(); }, []);

  // Fetch repo slugs when workspace changes
  useEffect(() => {
    if (!selectedWorkspace) return;
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
    instantScrollSessionRef.current = sessionId;
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
    // Cancel ongoing sync
    if (syncAbortRef.current) { syncAbortRef.current.abort(); setRepoSyncing(false); setRepoSyncStatus(""); }
    instantScrollSessionRef.current = sessionId;
    setActiveSessionId(sessionId);
    const session = sessions.find((s) => s.id === sessionId);
    if (session) {
      // Restore repo selection from this session
      if (session.workspaceSlug && session.workspaceSlug !== "github") {
        setSelectedWorkspace(session.workspaceSlug);
        setSelectedRepo(session.repositorySlug ?? null);
      } else if (session.workspaceSlug === "github") {
        // GitHub session — clear Bitbucket selection
        setSelectedRepo(null);
      } else {
        // No repo session — clear selection
        setSelectedRepo(null);
      }
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
    // Cancel ongoing sync
    if (syncAbortRef.current) { syncAbortRef.current.abort(); setRepoSyncing(false); setRepoSyncStatus(""); }
    // New chat should be clean — no repo pre-selected
    await createNewChat(selectedWorkspace, null);
    setSelectedRepo(null);
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
    if (!selectedWorkspace) return;

    const currentSession = sessions.find((s) => s.id === activeSessionId);

    // If current session already has this repo, do nothing
    if (currentSession?.repositorySlug === repoSlug) return;

    // If current session has messages (active conversation), assign repo to it — don't open new chat
    if (currentSession && currentSession.messages.length > 0) {
      setSelectedRepo(repoSlug);
      setSessions((prev) =>
        prev.map((s) => s.id === activeSessionId
          ? { ...s, workspaceSlug: selectedWorkspace, repositorySlug: repoSlug }
          : s
        )
      );
      syncRepoWithStatus(selectedWorkspace, repoSlug);
      if (activeSessionId && !activeSessionId.startsWith("local-")) {
        fetch(`/api/chat/sessions/${activeSessionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceSlug: selectedWorkspace, repositorySlug: repoSlug }),
        }).catch(() => {});
      }
      return;
    }

    // Empty session with no repo — assign it
    if (currentSession && !currentSession.repositorySlug) {
      setSelectedRepo(repoSlug);
      setSessions((prev) =>
        prev.map((s) => s.id === activeSessionId
          ? { ...s, workspaceSlug: selectedWorkspace, repositorySlug: repoSlug }
          : s
        )
      );
      syncRepoWithStatus(selectedWorkspace, repoSlug);
      return;
    }

    // Different repo — open new chat
    handleRepoSelect(selectedWorkspace, repoSlug);
  }

  async function handleGitHubAnalyze(fullName: string) {
    // Cancel ongoing sync
    if (syncAbortRef.current) { syncAbortRef.current.abort(); }

    // Create a new chat for this GitHub repo
    const localId = `local-${crypto.randomUUID()}`;
    const newSession: ChatSession = {
      id: localId,
      title: fullName.split("/").pop() ?? fullName,
      messages: [],
      repositorySlug: fullName,
      workspaceSlug: "github",
      folderId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    setSessions((prev) => [newSession, ...prev]);
    setActiveSessionId(localId);
    setSelectedRepo(null);

    // Show sync status banner (reuse same state as Bitbucket)
    const controller = new AbortController();
    syncAbortRef.current = controller;
    setRepoSyncing(true);
    setRepoSyncStatus("GitHub reposu klonlanıyor...");
    setSyncProgress(0);

    const statusTimers = [
      setTimeout(() => { setSyncProgress(10); setRepoSyncStatus("Dosya ağacı alınıyor..."); }, 2000),
      setTimeout(() => { setSyncProgress(30); setRepoSyncStatus("Dosya içerikleri indiriliyor..."); }, 5000),
      setTimeout(() => { setSyncProgress(55); setRepoSyncStatus("Commit geçmişi alınıyor..."); }, 10000),
      setTimeout(() => { setSyncProgress(75); setRepoSyncStatus("PR'lar ve branch'ler alınıyor..."); }, 15000),
      setTimeout(() => { setSyncProgress(90); setRepoSyncStatus("Neredeyse hazır..."); }, 20000),
    ];

    try {
      const [owner, repo] = fullName.split("/");
      await fetch("/api/github/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `https://github.com/${owner}/${repo}` }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setSyncProgress(100);
        setRepoSyncStatus("Repo hazır!");
        setTimeout(() => { setRepoSyncing(false); setRepoSyncStatus(""); setSyncProgress(0); }, 1200);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setSyncProgress(0);
      setRepoSyncStatus("GitHub analiz hatası");
      setTimeout(() => { setRepoSyncing(false); setRepoSyncStatus(""); }, 2000);
    } finally {
      statusTimers.forEach(clearTimeout);
      if (controller.signal.aborted) { setRepoSyncing(false); setRepoSyncStatus(""); setSyncProgress(0); }
      syncAbortRef.current = null;
    }
  }

  async function handleDeleteSession(id: string) {
    if (syncAbortRef.current) { syncAbortRef.current.abort(); setRepoSyncing(false); setRepoSyncStatus(""); }

    try {
      if (!id.startsWith("local-")) await fetch(`/api/chat/sessions/${id}`, { method: "DELETE" });
    } catch { /* keep optimistic UI deletion */ }

    const remaining = sessions.filter((s) => s.id !== id);
    setSessions(remaining);

    if (remaining.length === 0) {
      setSelectedRepo(null);
      await createNewChat(selectedWorkspace, null);
      return;
    }

    if (id === activeSessionId) {
      const next = remaining[0];
      instantScrollSessionRef.current = next.id;
      setActiveSessionId(next.id);
      if (next.workspaceSlug) setSelectedWorkspace(next.workspaceSlug);
      else setSelectedWorkspace(null);
      setSelectedRepo(next.repositorySlug ?? null);
      if (next.messages.length === 0) await loadSessionMessages(next.id);
    }
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
    // Cancel ongoing sync
    if (syncAbortRef.current) syncAbortRef.current.abort();
    const controller = new AbortController();
    syncAbortRef.current = controller;

    setRepoSyncing(true);
    setSyncProgress(0);
    setRepoSyncStatus("Repo bağlantısı kuruluyor...");

    // Smooth progress animation
    const steps = [
      { at: 300, progress: 5, status: "Repo bağlantısı kuruluyor..." },
      { at: 1500, progress: 12, status: "Dosya ağacı taranıyor..." },
      { at: 3000, progress: 25, status: "Dosya içerikleri indiriliyor..." },
      { at: 6000, progress: 45, status: "Dosya içerikleri indiriliyor..." },
      { at: 10000, progress: 60, status: "Commit geçmişi alınıyor..." },
      { at: 14000, progress: 75, status: "Branch'ler senkronize ediliyor..." },
      { at: 18000, progress: 85, status: "Neredeyse hazır..." },
      { at: 25000, progress: 92, status: "Neredeyse hazır..." },
    ];

    const timers = steps.map((s) =>
      setTimeout(() => {
        if (!controller.signal.aborted) {
          setSyncProgress(s.progress);
          setRepoSyncStatus(s.status);
        }
      }, s.at)
    );
    try {
      await fetch("/api/repos/sync", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace, repo }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setSyncProgress(100);
        setRepoSyncStatus("Repo hazır!");
        setTimeout(() => { setRepoSyncing(false); setRepoSyncStatus(""); setSyncProgress(0); }, 1200);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setSyncProgress(0);
      setRepoSyncStatus("Senkronizasyon hatası");
      setTimeout(() => { setRepoSyncing(false); setRepoSyncStatus(""); }, 2000);
    } finally {
      timers.forEach(clearTimeout);
      if (controller.signal.aborted) { setRepoSyncing(false); setRepoSyncStatus(""); setSyncProgress(0); }
      syncAbortRef.current = null;
    }
  }

  function handleStop() {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsLoading(false);
    }
  }

  async function handleEdit(messageId: string, newContent: string) {
    if (!activeSessionId || isLoading) return;
    const session = sessions.find((s) => s.id === activeSessionId);
    if (!session) return;

    const msgIndex = session.messages.findIndex((m) => m.id === messageId);
    if (msgIndex < 0 || session.messages[msgIndex].role !== "user") return;

    // Remove this message and everything after it (the AI response)
    setSessions((prev) =>
      prev.map((s) => s.id === activeSessionId
        ? { ...s, messages: s.messages.slice(0, msgIndex) }
        : s
      )
    );

    // Send the edited content
    await handleSend(newContent);
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
    let persistedSessionId: string | null = currentSessionId.startsWith("local-") ? null : currentSessionId;
    const currentSession = sessions.find((s) => s.id === currentSessionId);

    // If this is a local session (not yet in DB), persist it now
    if (currentSessionId.startsWith("local-")) {
      const localSessionId = currentSessionId;
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
            s.id === localSessionId
              ? { ...s, id: dbId, title: content.length > 40 ? content.slice(0, 40) + "…" : content }
              : s
          )
        );
        setActiveSessionId(dbId);
        currentSessionId = dbId;
        persistedSessionId = dbId;
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

    const botMessageId = crypto.randomUUID();

    try {
      const latestSession = sessions.find((s) => s.id === currentSessionId) ?? currentSession;
      const history = [...(latestSession?.messages ?? []), userMessage]
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content }));

      const ws = latestSession?.workspaceSlug ?? selectedWorkspace;
      const repo = latestSession?.repositorySlug ?? selectedRepo;
      const isGitHub = ws === "github";

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
        body: JSON.stringify({
          messages: history,
          workspaceSlug: isGitHub ? undefined : ws,
          repoSlug: isGitHub ? undefined : repo,
          githubRepo: isGitHub ? repo : undefined,
          sessionId: persistedSessionId,
          stream: true,
        }),
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
      let pendingDelta = "";
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      const flushPendingDelta = () => {
        if (!pendingDelta) return;
        const chunk = pendingDelta;
        pendingDelta = "";
        setSessions((prev) =>
          prev.map((s) => s.id === currentSessionId
            ? { ...s, messages: s.messages.map((m) => m.id === botMessageId ? { ...m, content: m.content + chunk } : m), updatedAt: new Date() }
            : s
          )
        );
      };

      const scheduleDeltaFlush = () => {
        if (flushTimer) return;
        flushTimer = setTimeout(() => {
          flushTimer = null;
          flushPendingDelta();
        }, 80);
      };

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
              pendingDelta += data.delta;
              scheduleDeltaFlush();
            }
            if (data.error) {
              if (flushTimer) clearTimeout(flushTimer);
              flushTimer = null;
              flushPendingDelta();
              setSessions((prev) =>
                prev.map((s) => s.id === currentSessionId
                  ? { ...s, messages: s.messages.map((m) => m.id === botMessageId ? { ...m, content: data.error } : m) }
                  : s
                )
              );
            }
            // Update session with detected repo
            if (data.done && data.detectedRepo) {
              if (flushTimer) clearTimeout(flushTimer);
              flushTimer = null;
              flushPendingDelta();
              const dr = data.detectedRepo;
              // Update current session — do NOT open new chat or trigger sync
              setSessions((prev) =>
                prev.map((s) => s.id === currentSessionId
                  ? { ...s, workspaceSlug: dr.workspace, repositorySlug: dr.repo }
                  : s
                )
              );
              if (dr.workspace && dr.workspace !== "github") {
                setSelectedWorkspace(dr.workspace);
                setSelectedRepo(dr.repo);
              }
              if (!currentSessionId.startsWith("local-")) {
                fetch(`/api/chat/sessions/${currentSessionId}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ workspaceSlug: dr.workspace, repositorySlug: dr.repo }),
                }).catch(() => {});
              }
            }
          } catch { /* ignore parse errors */ }
        }
      }
      if (flushTimer) clearTimeout(flushTimer);
      flushPendingDelta();
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
    }
  }

  const isGitHubSession = sessionWorkspace === "github";
  const effectiveRepo = isGitHubSession ? sessionRepo : (sessionRepo ?? selectedRepo);
  const effectiveWorkspace = isGitHubSession ? null : (sessionWorkspace ?? selectedWorkspace);
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
              {effectiveRepo && !isGitHubSession && effectiveWorkspace && (
                <RepoInfoCard workspace={effectiveWorkspace} repo={effectiveRepo} />
              )}
              {effectiveRepo && isGitHubSession && (
                <p className="text-[11px] text-[var(--text-tertiary)] truncate flex items-center gap-1">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0">
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                  </svg>
                  {effectiveRepo}
                </p>
              )}
              {effectiveRepo && !isGitHubSession && !effectiveWorkspace && (
                <p className="text-[11px] text-[var(--accent)] truncate">{effectiveRepo}</p>
              )}
            </div>
          </div>
          {!isGitHubSession && (
            <RepoSelector
              selectedWorkspace={selectedWorkspace}
              selectedRepo={selectedRepo}
              onSelect={handleRepoSelect}
            />
          )}
        </header>

        {/* Messages */}
        <div ref={messagesViewportRef} onScroll={handleMessagesScroll} className="flex-1 overflow-y-auto">
          {repoSyncing && (
            <div className="mx-4 mt-3 mb-1">
              <div className="max-w-3xl mx-auto">
                <div className="px-4 py-3 rounded-xl bg-[var(--accent-soft)] border border-[var(--accent)]/20">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2.5">
                      {syncProgress < 100 ? (
                        <svg className="animate-spin flex-shrink-0 w-3.5 h-3.5 text-[var(--accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                        </svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2.5">
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                      )}
                      <p className="text-[13px] font-medium text-[var(--accent)]">
                        {effectiveRepo ?? selectedRepo}
                      </p>
                    </div>
                    <span className="text-[11px] text-[var(--accent)]/70 tabular-nums">{syncProgress}%</span>
                  </div>
                  {/* Progress bar */}
                  <div className="h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-700 ease-out"
                      style={{
                        width: `${syncProgress}%`,
                        background: syncProgress >= 100
                          ? "var(--success)"
                          : "linear-gradient(90deg, var(--accent), var(--accent-hover))",
                      }}
                    />
                  </div>
                  <p className="text-[11px] text-[var(--accent)]/60 mt-1.5">{repoSyncStatus}</p>
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

              {/* GitHub public repo input */}
              {!effectiveRepo && (
                <div className="mt-8 w-full flex flex-col items-center">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="h-px w-12 bg-[var(--border)]" />
                    <span className="text-[11px] text-[var(--text-tertiary)] uppercase tracking-wider">veya</span>
                    <div className="h-px w-12 bg-[var(--border)]" />
                  </div>
                  <p className="text-[12px] text-[var(--text-tertiary)] mb-3">Public GitHub reposu analiz et</p>
                  <GitHubInput onAnalyze={handleGitHubAnalyze} />
                </div>
              )}
            </div>
          ) : (
            <div>
              {activeSession.messages.map((msg, idx) => {
                const isLastUserMsg = msg.role === "user" &&
                  activeSession.messages.slice(idx + 1).every((m) => m.role !== "user");
                return (
                  <ChatMessage
                    key={msg.id}
                    message={msg}
                    repoSlugs={selectedWorkspace ? repoSlugs : []}
                    onRepoClick={handleRepoClick}
                    onRegenerate={handleRegenerate}
                    onEdit={handleEdit}
                    isLastUser={isLastUserMsg}
                    isLast={idx === activeSession.messages.length - 1}
                    isStreaming={isLoading && idx === activeSession.messages.length - 1}
                  />
                );
              })}
              <div ref={messagesEndRef} className="h-4" />
            </div>
          )}
        </div>

        <ChatInput onSend={handleSend} onStop={handleStop} disabled={isLoading && !abortControllerRef.current} isStreaming={isLoading} repoSelected={!!effectiveRepo} />
      </main>
    </div>
  );
}
