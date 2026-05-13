"use client";

import { useState, useRef, useEffect, FormEvent } from "react";
import { useLanguage } from "./LanguageProvider";

interface ChatInputProps {
  onSend: (message: string) => void;
  onStop?: () => void;
  disabled?: boolean;
  isStreaming?: boolean;
  repoSelected?: boolean;
}

export default function ChatInput({ onSend, onStop, disabled, isStreaming, repoSelected }: ChatInputProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { t } = useLanguage();

  useEffect(() => {
    if (!disabled && !isStreaming && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [disabled, isStreaming]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [input]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setInput("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  return (
    <div className="bg-gradient-to-t from-[var(--bg-primary)] via-[var(--bg-primary)] to-transparent pt-2">
      <div className="max-w-3xl mx-auto px-4 md:px-8 pb-4">
        {isStreaming && (
          <div className="flex justify-center mb-2">
            <button
              onClick={onStop}
              className="flex items-center gap-2 px-4 py-1.5 rounded-full
                border border-[var(--border-light)] bg-[var(--bg-secondary)]
                hover:bg-[var(--bg-hover)] text-[13px] text-[var(--text-secondary)]
                transition-all hover:border-[var(--danger)]/30 hover:text-[var(--danger)]"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
              {t("stopAnswer")}
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="relative">
          <div className="flex items-end gap-2 rounded-2xl border border-[var(--border-light)] bg-[var(--bg-secondary)] focus-within:border-[var(--accent)]/40 transition-all focus-within:shadow-lg focus-within:shadow-[var(--accent)]/5">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={repoSelected ? t("repoQuestionPlaceholder") : t("genericPlaceholder")}
              disabled={disabled || isStreaming}
              rows={1}
              className="flex-1 resize-none bg-transparent px-4 py-3.5 text-[14.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] disabled:opacity-40"
              aria-label={t("messageInputAria")}
            />
            <button
              type="submit"
              disabled={disabled || isStreaming || !input.trim()}
              className="flex-shrink-0 m-1.5 w-9 h-9 rounded-xl flex items-center justify-center
                bg-[var(--accent)] hover:bg-[var(--accent-hover)]
                disabled:bg-[var(--bg-tertiary)] disabled:text-[var(--text-tertiary)]
                text-white transition-all disabled:cursor-not-allowed"
              aria-label={t("sendMessageAria")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          </div>
        </form>
        <p className="text-center text-[11px] text-[var(--text-tertiary)] mt-2">
          {t("aiDisclaimer")}
        </p>
      </div>
    </div>
  );
}
