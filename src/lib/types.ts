export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  messageCount?: number;
  repositorySlug?: string | null;
  workspaceSlug?: string | null;
  folderId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatFolder {
  id: string;
  name: string;
  isOpen?: boolean;
}
