import { useState, useRef, useCallback, useEffect } from 'react';
import { CallStatus, TranscriptEntry, LatencyInfo } from '../types';
import { containsFinalPhrase } from '../utils/scripts';

interface UseRealtimeAudioOptions {
  onTranscript?: (entry: TranscriptEntry) => void;
  onStatusChange?: (status: CallStatus) => void;
  onError?: (error: string) => void;
}

interface UseRealtimeAudioReturn {
  status: CallStatus;
  latency: LatencyInfo;
  startCall: (patientName?: string, systemPrompt?: string, voice?: string, mode?: string) => Promise<void>;
  endCall: () => void;
  isSupported: boolean;
}

export function useRealtimeAudio(options: UseRealtimeAudioOptions = {}): UseRealtimeAudioReturn {
  const { onTranscript, onStatusChange, onError } = options;
  
  const [status, setStatus] = useState<CallStatus>('idle');
  const [latency, setLatency] = useState<LatencyInfo>({
    lastTurnMs: null,
    avgMs: null,
    turnCount: 0,
  });

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  
  // Timing tracking
  const speechStoppedTimeRef = useRef<number | null>(null);
  const latenciesRef = useRef<number[]>([]);
  
  // Transcript accumulation
  const currentAssistantTextRef = useRef<string>('');
  const pendingUserTranscriptRef = useRef<string | null>(null);
  
  // NO_BARGE_IN: Track assistant speaking state for mic muting
  const assistantSpeakingRef = useRef<boolean>(false);
  const responseDelayTimerRef = useRef<number | null>(null);
  
  // Goodbye detection - only trigger hangup after audio finishes
  const goodbyeDetectedRef = useRef<boolean>(false);
  
  // Response delay from voice5.py (RESPONSE_DELAY_SEC = 0.4)
  const RESPONSE_DELAY_MS = 400;
  
  // Hangup delay after goodbye - wait for audio to finish playing
  // voice5.py uses HANGUP_AUDIO_BUFFER_SEC = 2.0
  const HANGUP_DELAY_MS = 2500;

  const isSupported = typeof navigator !== 'undefined' && 
    'mediaDevices' in navigator && 
    'getUserMedia' in navigator.mediaDevices;

  const updateStatus = useCallback((newStatus: CallStatus) => {
    setStatus(newStatus);
    onStatusChange?.(newStatus);
  }, [onStatusChange]);

  const addTranscript = useCallback((role: 'user' | 'assistant' | 'system', text: string) => {
    const entry: TranscriptEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      role,
      text,
      timestamp: new Date(),
    };
    onTranscript?.(entry);
  }, [onTranscript]);

  const endCall = useCallback(() => {
    // Close data channel
    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }

    // Close peer connection
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    // Stop media stream
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }

    // Clean up audio element
    if (audioElementRef.current) {
      audioElementRef.current.srcObject = null;
      audioElementRef.current = null;
    }

    updateStatus('ended');
    addTranscript('system', 'Call ended');
  }, [updateStatus, addTranscript]);

  const startCall = useCallback(async (
    patientName?: string,
    systemPrompt?: string,
    voice: string = 'cedar',
    mode: string = 'deterministic'
  ) => {
    if (!isSupported) {
      onError?.('Browser does not support audio recording');
      return;
    }

    try {
      updateStatus('connecting');
      addTranscript('system', 'Starting call...');

      // Reset state
      latenciesRef.current = [];
      setLatency({ lastTurnMs: null, avgMs: null, turnCount: 0 });
      currentAssistantTextRef.current = '';
      pendingUserTranscriptRef.current = null;
      goodbyeDetectedRef.current = false;

      // 1. Get ephemeral token from our API
      const sessionResponse = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          patientName, 
          systemPrompt: systemPrompt || '', 
          voice,
          mode
        }),
      });

      if (!sessionResponse.ok) {
        const error = await sessionResponse.json();
        throw new Error(error.error || 'Failed to create session');
      }

      const { client_secret } = await sessionResponse.json();
      
      // 2. Create peer connection
      const pc = new RTCPeerConnection();
      peerConnectionRef.current = pc;

      // 3. Set up audio element for playback with optimized settings
      const audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      // Preload setting helps with buffering (though WebRTC manages this internally)
      audioEl.preload = 'auto';
      audioElementRef.current = audioEl;

      // Handle incoming audio track
      pc.ontrack = (event) => {
        const stream = event.streams[0];
        audioEl.srcObject = stream;
        
        // Ensure playback starts immediately when audio is available
        audioEl.play().catch(err => {
          console.log('[audio] Autoplay blocked, user interaction required:', err);
        });
      };

      // 4. Get user's microphone
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        } 
      });
      mediaStreamRef.current = stream;

      // Add mic track to peer connection
      // We'll mute/unmute this track based on assistant speaking (NO_BARGE_IN)
      const audioTrack = stream.getAudioTracks()[0];
      stream.getTracks().forEach(track => {
        pc.addTrack(track, stream);
      });
      
      // Function to mute mic while assistant is speaking (NO_BARGE_IN from voice5.py)
      const updateMicMute = () => {
        if (audioTrack) {
          const shouldMute = assistantSpeakingRef.current;
          audioTrack.enabled = !shouldMute;
          console.log(`[mic] Track enabled: ${audioTrack.enabled} (assistant speaking: ${shouldMute})`);
        }
      };

      // 5. Create data channel for events
      const dc = pc.createDataChannel('oai-events');
      dataChannelRef.current = dc;

      dc.onopen = () => {
        console.log('Data channel open');
        updateStatus('connected');
        addTranscript('system', 'Connected - call starting');
        
        // Greeting preroll delay from voice5.py (GREETING_PREROLL_SEC = 0.2)
        // Small delay before sending initial response to ensure connection is stable
        setTimeout(() => {
          // Mute mic BEFORE triggering greeting (NO_BARGE_IN)
          assistantSpeakingRef.current = true;
          updateMicMute();
          dc.send(JSON.stringify({ type: 'response.create' }));
        }, 200);
      };

      dc.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleServerEvent(data, updateMicMute, dc);
        } catch (e) {
          console.error('Failed to parse server event:', e);
        }
      };

      dc.onerror = (error) => {
        console.error('Data channel error:', error);
        onError?.('Connection error');
      };

      dc.onclose = () => {
        console.log('Data channel closed');
        if (status !== 'ended') {
          endCall();
        }
      };

      // 6. Create and set local description (offer)
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // 7. Send offer to OpenAI and get answer
      const sdpResponse = await fetch(
        'https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${client_secret.value}`,
            'Content-Type': 'application/sdp',
          },
          body: offer.sdp,
        }
      );

      if (!sdpResponse.ok) {
        throw new Error('Failed to connect to OpenAI Realtime');
      }

      const answerSdp = await sdpResponse.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      console.log('WebRTC connection established');

    } catch (error) {
      console.error('Call start error:', error);
      const message = error instanceof Error ? error.message : 'Failed to start call';
      onError?.(message);
      updateStatus('error');
      addTranscript('system', `Error: ${message}`);
    }
  }, [isSupported, updateStatus, addTranscript, onError, endCall, status]);

  // Handle server events from data channel
  const handleServerEvent = useCallback((
    data: Record<string, unknown>,
    updateMicMute?: () => void,
    dataChannel?: RTCDataChannel
  ) => {
    const eventType = data.type as string;

    switch (eventType) {
      case 'session.created':
      case 'session.updated':
        // Session ready
        break;

      case 'input_audio_buffer.speech_started':
        // Cancel any pending response timer (user started speaking again)
        if (responseDelayTimerRef.current) {
          clearTimeout(responseDelayTimerRef.current);
          responseDelayTimerRef.current = null;
        }
        updateStatus('user_speaking');
        break;

      case 'input_audio_buffer.speech_stopped':
        speechStoppedTimeRef.current = Date.now();
        updateStatus('processing');
        
        // Schedule response creation with delay (like voice5.py _schedule_delayed_response)
        if (responseDelayTimerRef.current) {
          clearTimeout(responseDelayTimerRef.current);
        }
        responseDelayTimerRef.current = window.setTimeout(() => {
          if (dataChannel && dataChannel.readyState === 'open') {
            dataChannel.send(JSON.stringify({ type: 'response.create' }));
          }
          responseDelayTimerRef.current = null;
        }, RESPONSE_DELAY_MS);
        break;

      case 'response.created':
        currentAssistantTextRef.current = '';
        // Cancel response timer since response is now in progress
        if (responseDelayTimerRef.current) {
          clearTimeout(responseDelayTimerRef.current);
          responseDelayTimerRef.current = null;
        }
        // NO_BARGE_IN: Mute mic as soon as response starts (before audio plays)
        assistantSpeakingRef.current = true;
        updateMicMute?.();
        console.log('[mic] Muted - response starting');
        break;

      case 'response.audio_transcript.delta': {
        // Assistant is speaking - first audio chunk
        if (status !== 'assistant_speaking') {
          updateStatus('assistant_speaking');
          
          // Calculate latency
          if (speechStoppedTimeRef.current) {
            const latencyMs = Date.now() - speechStoppedTimeRef.current;
            latenciesRef.current.push(latencyMs);
            const avgMs = latenciesRef.current.reduce((a, b) => a + b, 0) / latenciesRef.current.length;
            setLatency({
              lastTurnMs: latencyMs,
              avgMs,
              turnCount: latenciesRef.current.length,
            });
            speechStoppedTimeRef.current = null;
          }
          
          // Add pending user transcript first
          if (pendingUserTranscriptRef.current) {
            addTranscript('user', pendingUserTranscriptRef.current);
            pendingUserTranscriptRef.current = null;
          }
        }
        
        // Accumulate transcript
        const delta = (data.delta as string) || '';
        currentAssistantTextRef.current += delta;
        break;
      }

      case 'response.audio_transcript.done': {
        // Full assistant transcript available
        const transcript = (data.transcript as string) || currentAssistantTextRef.current;
        if (transcript) {
          addTranscript('assistant', transcript);
          
          // Check for goodbye - but DON'T end call yet
          // Wait for response.done when all audio has been sent
          if (containsFinalPhrase(transcript)) {
            console.log('[goodbye] Detected in transcript, will end after audio finishes');
            goodbyeDetectedRef.current = true;
          }
        }
        currentAssistantTextRef.current = '';
        break;
      }

      case 'response.done':
        // Response complete - all audio has been SENT (may still be playing)
        if (status === 'assistant_speaking') {
          updateStatus('connected');
        }
        
        // If goodbye was detected, now end the call after audio buffer
        // This ensures the full goodbye message is heard
        if (goodbyeDetectedRef.current) {
          console.log(`[goodbye] Audio sent, waiting ${HANGUP_DELAY_MS}ms for playback to finish`);
          setTimeout(() => {
            console.log('[goodbye] Ending call now');
            endCall();
          }, HANGUP_DELAY_MS);
        } else {
          // NO_BARGE_IN: Unmute mic after assistant finishes
          // Add delay to ensure audio playback is complete before listening again
          setTimeout(() => {
            assistantSpeakingRef.current = false;
            updateMicMute?.();
            updateStatus('listening');  // Now actively listening for patient
            console.log('[mic] Unmuted - listening to patient');
          }, 800);  // Slightly longer delay to ensure audio finishes
        }
        break;

      case 'conversation.item.input_audio_transcription.completed': {
        // User speech transcribed
        const transcript = (data.transcript as string) || '';
        if (transcript) {
          // Store for display when assistant starts responding
          pendingUserTranscriptRef.current = transcript;
        }
        break;
      }

      case 'error': {
        const errorData = data.error as { message?: string } | undefined;
        const errorMsg = errorData?.message || 'Unknown error';
        console.error('Server error:', errorMsg);
        onError?.(errorMsg);
        break;
      }

      default:
        // Ignore other events
        break;
    }
  }, [status, updateStatus, addTranscript, endCall, onError]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  return {
    status,
    latency,
    startCall,
    endCall,
    isSupported,
  };
}
