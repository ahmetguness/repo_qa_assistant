"use client";

import { Message } from "@/lib/types";
import ReactMarkdown, { Components } from "react-markdown";
import { useCallback } from "react";

interface ChatMessageProps {
  message: Message;
  repoSlugs?: string[];
  onRepoClick?: (repoSlug: string) => void;
}

export default function ChatMessage({ message, repoSlugs = [], onRepoClick }: ChatMessageProps) {
  const isUser = message.role === "user";

  const markdownComponents: Components = useCallback(() => ({
    strong: ({ children }: { children?: React.ReactNode }) => {
      const text = String(children ?? "");
      // Check if this bold text matches a known repo slug or name
      const matchedSlug = repoSlugs.find(
        (slug) =>
          slug.toLowerCase() === text.toLowerCase() ||
          slug.toLowerCase().replace(/-/g, " ") === text.toLowerCase() ||
          slug.toLowerCase().replace(/_/g, " ") === text.toLowerCase()
      );

      if (matchedSlug && onRepoClick) {
        return (
          <button
            onClick={() => onRepoClick(matchedSlug)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md
              bg-[var(--accent-soft)] text-[var(--accent)] font-semibold
              hover:bg-[var(--accent)]/20 transition-colors cursor-pointer
              border border-[var(--accent)]/20"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
              <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
            </svg>
            {text}
          </button>
        );
      }

      return <strong>{children}</strong>;
    },
  }), [repoSlugs, onRepoClick])();

  return (
    <div className={`py-5 ${isUser ? "" : "bg-[var(--bg-secondary)]/30"}`}>
      <div className="max-w-3xl mx-auto px-4 md:px-8">
        <div className={`flex gap-3.5 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
          {/* Avatar */}
          <div
            className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold ${
              isUser
                ? "bg-[var(--accent)] text-white"
                : "bg-[var(--accent-soft)] text-[var(--accent)]"
            }`}
          >
            {isUser ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z" />
                <path d="M14 17h7M17.5 14v7" strokeLinecap="round" />
              </svg>
            )}
          </div>

          {/* Content */}
          <div className={`flex-1 min-w-0 ${isUser ? "text-right" : ""}`}>
            <p className="text-xs font-medium text-[var(--text-tertiary)] mb-1.5">
              {isUser ? "Sen" : "Repo QA Assistant"}
            </p>
            {isUser ? (
              <div className="inline-block text-[14.5px] leading-relaxed bg-[var(--user-bubble)] border border-[var(--border)] rounded-2xl rounded-tr-sm px-4 py-2.5 text-[var(--text-primary)]">
                {message.content}
              </div>
            ) : (
              <div className="markdown-body text-[14.5px] leading-7 text-[var(--text-primary)]">
                <ReactMarkdown components={markdownComponents}>{message.content}</ReactMarkdown>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
