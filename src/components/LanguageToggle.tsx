"use client";

import { useLanguage } from "./LanguageProvider";

export default function LanguageToggle() {
  const { language, setLanguage, t } = useLanguage();

  return (
    <div
      className="flex items-center rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-0.5"
      aria-label={t("languageLabel")}
    >
      {(["tr", "en"] as const).map((item) => (
        <button
          key={item}
          type="button"
          onClick={() => setLanguage(item)}
          className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${
            language === item
              ? "bg-[var(--accent-soft)] text-[var(--accent)]"
              : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
          }`}
          title={item === "tr" ? t("turkish") : t("english")}
        >
          {item.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
