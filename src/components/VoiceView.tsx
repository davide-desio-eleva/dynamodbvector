import { useVoiceAgent } from "../hooks/useVoiceAgent";

export function VoiceView() {
  const {
    isConnected,
    isRecording,
    isSpeaking,
    error,
    conversationHistory,
    connect,
    disconnect,
    startRecording,
    stopRecording,
  } = useVoiceAgent();

  return (
    <div className="voice-view">
      {error && (
        <div className="error-message" role="alert">
          <span>⚠️</span> {error}
        </div>
      )}

      {/* Connection controls */}
      <div className="voice-controls">
        {!isConnected ? (
          <button
            type="button"
            className="voice-btn connect"
            onClick={connect}
          >
            Connect to Voice Agent
          </button>
        ) : (
          <>
            {!isRecording ? (
              <button
                type="button"
                className="voice-btn record"
                onClick={startRecording}
              >
                🎤 Start Talking
              </button>
            ) : (
              <button
                type="button"
                className="voice-btn recording"
                onClick={stopRecording}
              >
                <span className="pulse" /> Stop Recording
              </button>
            )}
            <button
              type="button"
              className="voice-btn disconnect"
              onClick={disconnect}
            >
              Disconnect
            </button>
          </>
        )}
      </div>

      {/* Status indicator */}
      {isConnected && (
        <div className="voice-status">
          {isSpeaking && (
            <span className="status-badge speaking">
              🔊 Agent is speaking...
            </span>
          )}
          {isRecording && !isSpeaking && (
            <span className="status-badge listening">
              🎤 Listening...
            </span>
          )}
          {!isRecording && !isSpeaking && (
            <span className="status-badge idle">
              Ready
            </span>
          )}
        </div>
      )}

      {/* Conversation history */}
      <div className="voice-conversation">
        {conversationHistory.length === 0 && isConnected && (
          <div className="voice-welcome">
            <p>
              Start talking to search for products by voice.
              Try saying: <em>"I need a waterproof jacket for hiking, under 200 euros"</em>
            </p>
          </div>
        )}

        {conversationHistory
          .filter((turn) => turn.transcript.trim().length > 0)
          .map((turn, i) => (
            <div key={i} className={`voice-bubble ${turn.role}`}>
              <span className="bubble-role">
                {turn.role === "user" ? "👤 You" : "🛒 Assistant"}
              </span>
              <p>{turn.transcript}</p>
            </div>
          ))}
      </div>
    </div>
  );
}
