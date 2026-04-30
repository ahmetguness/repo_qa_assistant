"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Message, ChatSession } from "@/lib/types";
import ChatMessage from "./ChatMessage";
import ChatInput from "./ChatInput";
import Sidebar from "./Sidebar";
import RepoSelector from "./RepoSelector";

interface ChatbotProps {
  user: {
    id: string;
    name?: string | null;
    image?: string | null;
  };
}

function createSession(title = "Yeni Sohbet"): ChatSession {
  const now = new Date();
  return { id: crypto.randomUUID(), title, messages: [], createdAt: now, updatedAt: now };
}

const initialSession = createSession();

export default function Chatbot({ user }: ChatbotProps) {
  const [sessions, setSessions] = useState<ChatSession[]>([initialSession]);
  const [activeSessionId, setActiveSessionId] = useState(initialSession.id);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [repoSlugs, setRepoSlugs] = useState<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeSession = sessions.find((s) => s.id === activeSessionId)!;

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => { scrollToBottom(); }, [activeSession.messages, scrollToBottom]);

  // Fetch repo slugs when workspace changes
  useEffect(() => {
    if (!selectedWorkspace) { setRepoSlugs([]); return; }
    fetch(`/api/repos?workspace=${selectedWorkspace}`)
      .then((r) => r.json())
      .then((data) => {
        const slugs = (data.repos ?? []).map((r: { slug: string }) => r.slug);
        setRepoSlugs(slugs);
      })
      .catch(() => {});
  }, [selectedWorkspace]);

  function handleRepoClick(repoSlug: string) {
    if (selectedWorkspace) {
      setSelectedRepo(repoSlug);
      // Trigger sync in background
      fetch("/api/repos/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: selectedWorkspace, repo: repoSlug }),
      }).catch(() => {});
    }
  }

  function handleNewChat() {
    const session = createSession();
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
  }

  function handleDeleteSession(id: string) {
    setSessions((prev) => {
      const filtered = prev.filter((s) => s.id !== id);
      if (filtered.length === 0) {
        const fresh = createSession();
        setActiveSessionId(fresh.id);
        return [fresh];
      }
      if (id === activeSessionId) setActiveSessionId(filtered[0].id);
      return filtered;
    });
  }

  function updateSessionMessages(sessionId: string, newMessage: Message) {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sessionId) return s;
        const updated = { ...s, messages: [...s.messages, newMessage], updatedAt: new Date() };
        if (newMessage.role === "user" && s.messages.filter((m) => m.role === "user").length === 0) {
          updated.title = newMessage.content.length > 35 ? newMessage.content.slice(0, 35) + "…" : newMessage.content;
        }
        return updated;
      })
    );
  }

  async function handleSend(content: string) {
    const userMessage: Message = { id: crypto.randomUUID(), role: "user", content, timestamp: new Date() };
    updateSessionMessages(activeSessionId, userMessage);
    setIsLoading(true);
    setLoadingStatus("Repo verileri kontrol ediliyor...");

    // Progress timer for status updates
    const statusMessages = [
      { delay: 3000, text: "Dosyalar analiz ediliyor..." },
      { delay: 7000, text: "AI yanıt hazırlıyor..." },
      { delay: 15000, text: "Büyük repo, biraz daha sürebilir..." },
      { delay: 25000, text: "Neredeyse bitti..." },
    ];
    const timers = statusMessages.map((s) =>
      setTimeout(() => setLoadingStatus(s.text), s.delay)
    );

    try {
      const currentSession = sessions.find((s) => s.id === activeSessionId);
      const history = [...(currentSession?.messages ?? []), userMessage]
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content }));

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, workspaceSlug: selectedWorkspace, repoSlug: selectedRepo }),
      });
      const data = await res.json();
      updateSessionMessages(activeSessionId, {
        id: crypto.randomUUID(), role: "assistant",
        content: data.reply ?? data.error ?? "Bir hata oluştu.", timestamp: new Date(),
      });
    } catch {
      updateSessionMessages(activeSessionId, {
        id: crypto.randomUUID(), role: "assistant",
        content: "Bağlantı hatası oluştu. Lütfen tekrar deneyin.", timestamp: new Date(),
      });
    } finally {
      timers.forEach(clearTimeout);
      setIsLoading(false);
      setLoadingStatus("");
    }
  }

  const quickQuestions = selectedRepo
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

  return (
    <div className="flex h-full">
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={setActiveSessionId}
        onNewChat={handleNewChat}
        onDeleteSession={handleDeleteSession}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onSignOut={() => { window.location.href = "/api/auth/signout"; }}
        userName={user.name ?? undefined}
        userImage={user.image ?? undefined}
      />

      <main className="flex-1 flex flex-col min-w-0 bg-[var(--bg-primary)]">
        {/* Top bar */}
        <header className="flex items-center justify-between h-13 px-4 border-b border-[var(--border)] bg-[var(--bg-secondary)]/50 backdrop-blur-sm">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] transition-colors"
              aria-label="Menüyü aç"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M3 12h18M3 6h18M3 18h18" />
              </svg>
            </button>
            <div className="min-w-0">
              <h2 className="text-[13px] font-medium text-[var(--text-primary)] truncate">
                {activeSession.title}
              </h2>
            </div>
          </div>

          <RepoSelector
            selectedWorkspace={selectedWorkspace}
            selectedRepo={selectedRepo}
            onSelect={(ws, repo) => { setSelectedWorkspace(ws); setSelectedRepo(repo); }}
          />
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          {activeSession.messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full px-4">
              <div className="w-16 h-16 rounded-2xl bg-[var(--accent-soft)] flex items-center justify-center mb-6">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5">
                  <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z" />
                  <path d="M14 17h7M17.5 14v7" strokeLinecap="round" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-[var(--text-primary)] mb-2">
                Repo QA Assistant
              </h3>
              <p className="text-sm text-[var(--text-tertiary)] text-center max-w-md mb-8 leading-relaxed">
                {selectedRepo
                  ? <>
                      <span className="text-[var(--accent)] font-medium">{selectedRepo}</span> reposu seçili ve analiz ediliyor. Aşağıdaki sorulardan birini deneyin veya kendi sorunuzu yazın.
                    </>
                  : "Sağ üstten bir repo seçin veya doğrudan soru sorun. Repo adını mesajda belirtirseniz otomatik algılanır."}
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-lg w-full">
                {quickQuestions.map((q) => (
                  <button
                    key={q.text}
                    onClick={() => handleSend(q.text)}
                    className="flex items-center gap-3 text-left px-4 py-3 rounded-xl
                      border border-[var(--border)] bg-[var(--bg-secondary)]/50
                      hover:bg-[var(--bg-hover)] hover:border-[var(--border-light)]
                      text-[13px] text-[var(--text-secondary)] transition-all"
                  >
                    <span className="text-base">{q.icon}</span>
                    {q.text}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div>
              {activeSession.messages.map((msg) => (
                <ChatMessage
                  key={msg.id}
                  message={msg}
                  repoSlugs={repoSlugs}
                  onRepoClick={handleRepoClick}
                />
              ))}

              {isLoading && (
                <div className="py-5 bg-[var(--bg-secondary)]/30">
                  <div className="max-w-3xl mx-auto px-4 md:px-8">
                    <div className="flex gap-3.5">
                      <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-[var(--accent-soft)] flex items-center justify-center">
                        <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5">
                          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                        </svg>
                      </div>
                      <div className="pt-1">
                        <p className="text-xs font-medium text-[var(--text-tertiary)] mb-1.5">Repo QA Assistant</p>
                        <div className="flex items-center gap-2.5">
                          <div className="flex gap-1.5">
                            <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
                            <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
                            <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
                          </div>
                          <span className="text-[13px] text-[var(--text-secondary)]">
                            {loadingStatus}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} className="h-4" />
            </div>
          )}
        </div>

        <ChatInput onSend={handleSend} disabled={isLoading} repoSelected={!!selectedRepo} />
      </main>
    </div>
  );
}
