import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import Chatbot from "@/components/Chatbot";

export default async function Home() {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  return (
    <Chatbot
      user={{
        id: session.user.id!,
        name: session.user.name,
        image: session.user.image,
      }}
    />
  );
}
