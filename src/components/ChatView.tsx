import { useMemo } from "react";
import {
  AIConversation,
  createAIHooks,
} from "@aws-amplify/ui-react-ai";
import Markdown from "react-markdown";
import { getClient } from "../client";

function useChat() {
  const { useAIConversation } = useMemo(
    () => createAIHooks(getClient()),
    []
  );
  return useAIConversation("chat");
}

/** Strip <thinking>...</thinking> tags from model output */
function cleanResponse(text: string): string {
  return text.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, "").trim();
}

export function ChatView() {
  const [
    {
      data: { messages },
      isLoading,
    },
    handleSendMessage,
  ] = useChat();

  return (
    <div className="chat-view">
      <AIConversation
        messages={messages}
        isLoading={isLoading}
        handleSendMessage={handleSendMessage}
        messageRenderer={{
          text: ({ text }) => <Markdown>{cleanResponse(text)}</Markdown>,
        }}
        avatars={{
          ai: {
            username: "Shopping Assistant",
            avatar: <span>🛒</span>,
          },
          user: {
            username: "You",
            avatar: <span>👤</span>,
          },
        }}
        welcomeMessage={
          <div className="chat-welcome">
            <h3>Welcome to the AI Shopping Assistant</h3>
            <p>
              I can help you find the right outdoor gear. Just describe what
              you need — I'll search our catalog by meaning, not keywords.
            </p>
            <p className="chat-examples">
              Try: <em>"I'm hiking in Iceland in October, need something waterproof under €200"</em>
            </p>
          </div>
        }
        allowAttachments={false}
      />
    </div>
  );
}
