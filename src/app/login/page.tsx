import { auth, signIn } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function LoginPage() {
  const session = await auth();
  if (session) redirect("/");

  return (
    <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)]">
      <div className="w-full max-w-md mx-4">
        {/* Logo & branding */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[var(--accent-soft)] mb-6">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5">
              <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z" />
              <path d="M14 17h7M17.5 14v7" strokeLinecap="round" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-2">
            Repo QA Assistant
          </h1>
          <p className="text-sm text-[var(--text-secondary)] max-w-xs mx-auto leading-relaxed">
            Bitbucket repolarınızı AI ile analiz edin. Dosyalar, kodlar, PR&apos;lar ve commit&apos;ler hakkında sorular sorun.
          </p>
        </div>

        {/* Login card */}
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-2xl p-6">
          <div className="flex items-center gap-3 mb-5 pb-5 border-b border-[var(--border)]">
            <div className="w-10 h-10 rounded-xl bg-[var(--bg-tertiary)] flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="1.5">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">Güvenli giriş</p>
              <p className="text-xs text-[var(--text-tertiary)]">Bitbucket OAuth 2.0 ile</p>
            </div>
          </div>

          <form
            action={async () => {
              "use server";
              await signIn("bitbucket", { redirectTo: "/" });
            }}
          >
            <button
              type="submit"
              className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl
                bg-[#0052CC] hover:bg-[#0747A6] text-white font-medium text-sm
                transition-all hover:shadow-lg hover:shadow-blue-500/20"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M.778 1.213a.768.768 0 00-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 00.77-.646l3.27-20.03a.768.768 0 00-.768-.891zM14.52 15.53H9.522L8.17 8.466h7.561z" />
              </svg>
              Bitbucket ile Giriş Yap
            </button>
          </form>

          <div className="mt-4 flex items-start gap-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" className="mt-0.5 flex-shrink-0">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4M12 8h.01" />
            </svg>
            <p className="text-[11px] text-[var(--text-tertiary)] leading-relaxed">
              Giriş yaparak Bitbucket hesabınızdaki repolara salt okunur erişim izni vermiş olursunuz. Hiçbir veri değiştirilmez.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
