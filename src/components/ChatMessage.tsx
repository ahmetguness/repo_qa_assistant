"use client";

import { useState, useCallback } from "react";
import { Message } from "@/lib/types";
import ReactMarkdown, { Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";

interface ChatMessageProps {
  message: Message;
  repoSlugs?: string[];
  onRepoClick?: (repoSlug: string) => void;
  onRegenerate?: (messageId: string) => void;
  onEdit?: (messageId: string, newContent: string) => void;
  isLastUser?: boolean;
  isLast?: boolean;
  isStreaming?: boolean;
}

function CopyButton({ text, label = "Kopyala" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px]
        text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]
        hover:bg-[var(--bg-hover)] transition-colors"
      title={label}
    >
      {copied ? (
        <>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2"><path d="M20 6L9 17l-5-5" /></svg>
          <span className="text-[var(--success)]">Kopyalandı</span>
        </>
      ) : (
        <>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          {label}
        </>
      )}
    </button>
  );
}

export default function ChatMessage({ message, repoSlugs = [], onRepoClick, onRegenerate, onEdit, isLastUser, isLast, isStreaming }: ChatMessageProps) {
  const isUser = message.role === "user";
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);

  const markdownComponents: Components = useCallback(() => ({
    strong: ({ children }: { children?: React.ReactNode }) => {
      const text = String(children ?? "");
      const matchedSlug = repoSlugs.find(
        (slug) =>
          slug.toLowerCase() === text.toLowerCase() ||
          slug.toLowerCase().replace(/-/g, " ") === text.toLowerCase() ||
          slug.toLowerCase().replace(/_/g, " ") === text.toLowerCase()
      );
      if (matchedSlug && onRepoClick) {
        return (
          <button onClick={() => onRepoClick(matchedSlug)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--accent-soft)] text-[var(--accent)] font-semibold hover:bg-[var(--accent)]/20 transition-colors cursor-pointer border border-[var(--accent)]/20">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
              <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
            </svg>
            {text}
          </button>
        );
      }
      return <strong>{children}</strong>;
    },
    pre: ({ children }: { children?: React.ReactNode }) => {
      // Extract code text for copy button
      let codeText = "";
      const extractText = (node: React.ReactNode): void => {
        if (typeof node === "string") { codeText += node; return; }
        if (Array.isArray(node)) { node.forEach(extractText); return; }
        if (node && typeof node === "object" && "props" in node) {
          extractText((node as { props: { children?: React.ReactNode } }).props.children);
        }
      };
      extractText(children);

      return (
        <div className="relative group/code">
          <div className="absolute top-2 right-2 opacity-0 group-hover/code:opacity-100 transition-opacity">
            <CopyButton text={codeText.trim()} label="Kodu kopyala" />
          </div>
          <pre>{children}</pre>
        </div>
      );
    },
  }), [repoSlugs, onRepoClick])();

  return (
    <div className={`py-5 group/msg ${isUser ? "" : "bg-[var(--bg-secondary)]/30"}`}>
      <div className="max-w-3xl mx-auto px-4 md:px-8">
        <div className={`flex gap-3.5 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
          {/* Avatar */}
          <div className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold ${
            isUser ? "bg-[var(--accent)] text-white" : "bg-[var(--accent-soft)] text-[var(--accent)]"
          }`}>
            {isUser ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z" /><path d="M14 17h7M17.5 14v7" strokeLinecap="round" /></svg>
            )}
          </div>

          {/* Content */}
          <div className={`flex-1 min-w-0 ${isUser ? "text-right" : ""}`}>
            <p className="text-xs font-medium text-[var(--text-tertiary)] mb-1.5">
              {isUser ? "Sen" : "Repo QA Assistant"}
            </p>
            {isUser ? (
              <>
                {isEditing ? (
                  <div className="inline-block w-full max-w-md text-left">
                    <textarea
                      autoFocus
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          const trimmed = editContent.trim();
                          if (trimmed && onEdit) { onEdit(message.id, trimmed); }
                          setIsEditing(false);
                        }
                        if (e.key === "Escape") { setIsEditing(false); setEditContent(message.content); }
                      }}
                      className="w-full resize-none rounded-xl border border-[var(--accent)]/40 bg-[var(--user-bubble)] px-4 py-2.5 text-[14.5px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                      rows={Math.min(editContent.split("\n").length + 1, 6)}
                    />
                    <div className="flex justify-end gap-2 mt-2">
                      <button
                        onClick={() => { setIsEditing(false); setEditContent(message.content); }}
                        className="px-3 py-1 rounded-lg text-[12px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
                      >
                        İptal
                      </button>
                      <button
                        onClick={() => {
                          const trimmed = editContent.trim();
                          if (trimmed && onEdit) { onEdit(message.id, trimmed); }
                          setIsEditing(false);
                        }}
                        disabled={!editContent.trim()}
                        className="px-3 py-1 rounded-lg text-[12px] bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-40 transition-colors"
                      >
                        Gönder
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="inline-block relative">
                    <div className="text-[14.5px] leading-relaxed bg-[var(--user-bubble)] border border-[var(--border)] rounded-2xl rounded-tr-sm px-4 py-2.5 text-[var(--text-primary)]">
                      {message.content}
                    </div>
                    {isLastUser && onEdit && !isStreaming && (
                      <button
                        onClick={() => { setEditContent(message.content); setIsEditing(true); }}
                        className="absolute -bottom-6 right-0 flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px]
                          text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]
                          hover:bg-[var(--bg-hover)] transition-colors opacity-0 group-hover/msg:opacity-100"
                        title="Düzenle ve tekrar gönder"
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                        Düzenle
                      </button>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="markdown-body text-[14.5px] leading-7 text-[var(--text-primary)]">
                {isStreaming ? (
                  <div className="streaming-text whitespace-pre-wrap break-words">
                    {message.content}
                    <span className="streaming-caret" aria-hidden="true" />
                  </div>
                ) : (
                  <ReactMarkdown rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
                    {message.content}
                  </ReactMarkdown>
                )}
              </div>
            )}

            {/* Action buttons for AI messages */}
            {!isUser && message.content && !isStreaming && (
              <div className="flex items-center gap-1 mt-2 opacity-0 group-hover/msg:opacity-100 transition-opacity">
                <CopyButton text={message.content} label="Mesajı kopyala" />
                {isLast && onRegenerate && (
                  <button
                    onClick={() => onRegenerate(message.id)}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px]
                      text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]
                      hover:bg-[var(--bg-hover)] transition-colors"
                    title="Yeniden oluştur"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M1 4v6h6M23 20v-6h-6" /><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
                    </svg>
                    Yeniden oluştur
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
