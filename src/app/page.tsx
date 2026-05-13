import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import Chatbot from "@/components/Chatbot";
import { LanguageProvider } from "@/components/LanguageProvider";

export default async function Home() {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  return (
    <LanguageProvider>
      <Chatbot
        user={{
          id: session.user.id!,
          name: session.user.name,
          image: session.user.image,
        }}
      />
    </LanguageProvider>
  );
}
