/**
 * React hook for bidirectional voice streaming with the local Strands BidiAgent.
 * Captures microphone audio as PCM, sends it over WebSocket, and plays back
 * the agent's audio response.
 */
import { useState, useRef, useCallback, useEffect } from "react";
import audioCaptureProcessorUrl from "../audio-processor.worklet.js?url";
import { buildVoiceConnection } from "../voice-connection";

export interface ConversationTurn {
  role: "user" | "assistant";
  transcript: string;
  timestamp: Date;
}

export interface VoiceAgentState {
  isConnected: boolean;
  isRecording: boolean;
  isSpeaking: boolean;
  error: string | null;
  agentTranscript: string;
  conversationHistory: ConversationTurn[];
}

export function useVoiceAgent() {
  const [state, setState] = useState<VoiceAgentState>({
    isConnected: false,
    isRecording: false,
    isSpeaking: false,
    error: null,
    agentTranscript: "",
    conversationHistory: [],
  });

  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<{ stop: () => void } | null>(null);
  const recordingCtxRef = useRef<AudioContext | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const audioQueueRef = useRef<AudioBuffer[]>([]);
  const isPlayingRef = useRef(false);

  // ── Audio playback queue ────────────────────────────────────────────
  const playNext = useCallback(() => {
    if (audioQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      setState((p) => ({ ...p, isSpeaking: false }));
      return;
    }
    if (
      !playbackCtxRef.current ||
      playbackCtxRef.current.state === "closed"
    ) {
      audioQueueRef.current = [];
      isPlayingRef.current = false;
      return;
    }
    isPlayingRef.current = true;
    setState((p) => ({ ...p, isSpeaking: true }));

    const buf = audioQueueRef.current.shift()!;
    const src = playbackCtxRef.current.createBufferSource();
    src.buffer = buf;
    src.connect(playbackCtxRef.current.destination);
    src.onended = () => playNext();
    src.start();
  }, []);

  const queueAudio = useCallback(
    async (base64: string, sampleRate: number) => {
      if (
        !playbackCtxRef.current ||
        playbackCtxRef.current.state === "closed"
      ) {
        playbackCtxRef.current = new AudioContext({ sampleRate });
      }
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

      const pcm = new Int16Array(bytes.buffer);
      const floats = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++)
        floats[i] = pcm[i] / (pcm[i] < 0 ? 0x8000 : 0x7fff);

      const audioBuf = playbackCtxRef.current.createBuffer(
        1,
        floats.length,
        sampleRate
      );
      audioBuf.getChannelData(0).set(floats);
      audioQueueRef.current.push(audioBuf);

      if (!isPlayingRef.current) playNext();
    },
    [playNext]
  );

  // ── WebSocket message handler ───────────────────────────────────────
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === "bidi_audio_stream" && data.audio) {
          queueAudio(data.audio, data.sample_rate || 16000);
        }

        if (data.type === "bidi_transcript_stream") {
          const role: "user" | "assistant" =
            data.role === "user" ? "user" : "assistant";
          const isFinal = data.is_final !== false;
          const text = (data.text || "").trim();
          if (!text) return;

          // Commit EVERY transcript chunk as its own bubble. We never overwrite
          // or hide anything the AI says. Only skip a chunk if it is an exact
          // duplicate of the previous one (some providers resend the final of
          // a partial we just showed).
          setState((prev) => {
            const history = prev.conversationHistory;
            const last = history[history.length - 1];
            if (last && last.role === role && last.transcript === text) {
              // Exact duplicate, ignore.
              return { ...prev, isSpeaking: false };
            }
            return {
              ...prev,
              conversationHistory: [
                ...history,
                { role, transcript: text, timestamp: new Date() },
              ],
              isSpeaking: role === "assistant" && !isFinal,
            };
          });
        }

        if (data.type === "bidi_text_response" && data.text) {
          setState((prev) => ({
            ...prev,
            conversationHistory: [
              ...prev.conversationHistory,
              {
                role: "assistant" as const,
                transcript: data.text,
                timestamp: new Date(),
              },
            ],
            agentTranscript: "",
          }));
        }

        if (data.type === "bidi_interruption") {
          audioQueueRef.current = [];
          isPlayingRef.current = false;
          setState((p) => ({
            ...p,
            isSpeaking: false,
            agentTranscript: "",
          }));
        }
      } catch (err) {
        console.error("[WS] Parse error:", err);
      }
    },
    [queueAudio]
  );

  // ── Connect ─────────────────────────────────────────────────────────
  const connect = useCallback(async () => {
    setState((p) => ({ ...p, error: null }));
    try {
      // Local dev: plain ws:// URL. Deployed: AgentCore URL with the Cognito
      // bearer token passed via the Sec-WebSocket-Protocol subprotocol.
      const { url, protocols } = await buildVoiceConnection();
      const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () =>
        setState((p) => ({ ...p, isConnected: true, error: null }));
      ws.onclose = () =>
        setState((p) => ({
          ...p,
          isConnected: false,
          isRecording: false,
          isSpeaking: false,
        }));
      ws.onerror = () =>
        setState((p) => ({
          ...p,
          error:
            "WebSocket connection failed. If running locally, is the voice agent started (npm run dev:agent)?",
        }));
      ws.onmessage = handleMessage;
    } catch (err: any) {
      setState((p) => ({ ...p, error: err.message }));
    }
  }, [handleMessage]);

  // ── Disconnect ──────────────────────────────────────────────────────
  const disconnect = useCallback(() => {
    recorderRef.current?.stop();
    wsRef.current?.close();
    wsRef.current = null;
    audioQueueRef.current = [];
    isPlayingRef.current = false;

    if (playbackCtxRef.current?.state !== "closed")
      playbackCtxRef.current?.close();
    if (recordingCtxRef.current?.state !== "closed")
      recordingCtxRef.current?.close();

    setState({
      isConnected: false,
      isRecording: false,
      isSpeaking: false,
      error: null,
      agentTranscript: "",
      conversationHistory: [],
    });
  }, []);

  // ── Start recording ─────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      const ctx = new AudioContext({ sampleRate: 16000 });
      recordingCtxRef.current = ctx;

      await ctx.audioWorklet.addModule(audioCaptureProcessorUrl);

      const source = ctx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(ctx, "audio-capture-processor");

      worklet.port.onmessage = (ev) => {
        if (wsRef.current?.readyState !== WebSocket.OPEN) return;
        const pcm = ev.data.data as Int16Array;
        const base64 = btoa(
          String.fromCharCode(...new Uint8Array(pcm.buffer))
        );
        wsRef.current.send(
          JSON.stringify({
            type: "bidi_audio_input",
            audio: base64,
            format: "pcm",
            sample_rate: 16000,
            channels: 1,
          })
        );
      };

      source.connect(worklet);
      worklet.connect(ctx.destination);

      recorderRef.current = {
        stop: () => {
          worklet.disconnect();
          source.disconnect();
          ctx.close();
          stream.getTracks().forEach((t) => t.stop());
        },
      };

      setState((p) => ({ ...p, isRecording: true }));
    } catch (err: any) {
      setState((p) => ({
        ...p,
        error: `Microphone error: ${err.message}`,
      }));
    }
  }, []);

  // ── Stop recording ──────────────────────────────────────────────────
  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setState((p) => ({ ...p, isRecording: false }));
  }, []);

  // ── Cleanup ─────────────────────────────────────────────────────────
  useEffect(() => {
    return () => disconnect();
  }, [disconnect]);

  return {
    ...state,
    connect,
    disconnect,
    startRecording,
    stopRecording,
  };
}
