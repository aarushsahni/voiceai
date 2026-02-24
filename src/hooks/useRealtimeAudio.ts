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
  startCall: (
    systemPrompt?: string, 
    voice?: string, 
    variableValues?: Record<string, string>
  ) => Promise<void>;
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
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioMonitorIntervalRef = useRef<number | null>(null);
  const onAudioSilenceCallbackRef = useRef<(() => void) | null>(null);
  
  // Timing tracking
  const speechStoppedTimeRef = useRef<number | null>(null);
  const latenciesRef = useRef<number[]>([]);
  
  // Transcript accumulation
  const currentAssistantTextRef = useRef<string>('');
  
  // NO_BARGE_IN: Track assistant speaking state for mic muting
  const assistantSpeakingRef = useRef<boolean>(false);
  const responseDelayTimerRef = useRef<number | null>(null);
  
  // Goodbye detection - only trigger hangup after audio finishes
  const goodbyeDetectedRef = useRef<boolean>(false);
  
  // Prevent duplicate endCall invocations
  const endingCallRef = useRef<boolean>(false);
  
  // Track if we're waiting for goodbye audio to finish (prevents dc.onclose from ending early)
  const waitingForGoodbyeRef = useRef<boolean>(false);
  
  // Track last audio delta time to estimate when audio finishes
  const lastAudioDeltaTimeRef = useRef<number>(0);
  const transcriptLengthRef = useRef<number>(0);
  const eventCountRef = useRef<number>(0);
  const hasAnyAssistantTranscriptRef = useRef<boolean>(false);
  const initialGreetingRetryCountRef = useRef<number>(0);
  const initialGreetingWatchdogRef = useRef<number | null>(null);
  
  // Track if we're currently in a response (to avoid stale closure issues with status state)
  const inResponseRef = useRef<boolean>(false);

  
  const RESPONSE_DELAY_MS = 400;
  
  // Silence detection thresholds (using RMS audio level)
  const SILENCE_THRESHOLD = 0.03;
  const SILENCE_DURATION_MS = 400;
  const MAX_WAIT_FOR_SILENCE_MS = 15000;

  // Keep refs to latest callbacks to avoid stale closures in WebRTC event handlers
  const onTranscriptRef = useRef(onTranscript);
  const onStatusChangeRef = useRef(onStatusChange);
  const onErrorRef = useRef(onError);
  useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  const isSupported = typeof navigator !== 'undefined' && 
    'mediaDevices' in navigator && 
    'getUserMedia' in navigator.mediaDevices;

  const updateStatus = useCallback((newStatus: CallStatus) => {
    setStatus(newStatus);
    onStatusChangeRef.current?.(newStatus);
  }, []);

  const addTranscript = useCallback((role: 'user' | 'assistant' | 'system', text: string) => {
    const entry: TranscriptEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      role,
      text,
      timestamp: new Date(),
    };
    onTranscriptRef.current?.(entry);
  }, []);

  const waitForAudioSilence = useCallback((onSilence: () => void, fallbackDelayMs: number) => {
    if (audioMonitorIntervalRef.current) {
      clearInterval(audioMonitorIntervalRef.current);
      audioMonitorIntervalRef.current = null;
    }
    
    const analyser = analyserRef.current;
    if (!analyser) {
      console.log(`[audio] No analyser, using fallback delay: ${fallbackDelayMs}ms`);
      setTimeout(onSilence, fallbackDelayMs);
      return;
    }
    
    const bufferLength = analyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);
    let silenceStartTime: number | null = null;
    const startTime = Date.now();
    let hasSeenAudio = false;
    
    onAudioSilenceCallbackRef.current = onSilence;
    
    audioMonitorIntervalRef.current = window.setInterval(() => {
      analyser.getByteTimeDomainData(dataArray);
      
      let sumSquares = 0;
      for (let i = 0; i < bufferLength; i++) {
        const normalized = (dataArray[i] - 128) / 128;
        sumSquares += normalized * normalized;
      }
      const rms = Math.sqrt(sumSquares / bufferLength);
      
      const isSilent = rms < SILENCE_THRESHOLD;
      
      if (!isSilent) {
        hasSeenAudio = true;
        silenceStartTime = null;
      } else if (hasSeenAudio) {
        if (!silenceStartTime) {
          silenceStartTime = Date.now();
          console.log(`[audio] Silence started (RMS: ${rms.toFixed(4)})`);
        } else if (Date.now() - silenceStartTime >= SILENCE_DURATION_MS) {
          console.log(`[audio] Silence confirmed after ${Date.now() - startTime}ms total`);
          if (audioMonitorIntervalRef.current) {
            clearInterval(audioMonitorIntervalRef.current);
            audioMonitorIntervalRef.current = null;
          }
          onAudioSilenceCallbackRef.current = null;
          onSilence();
          return;
        }
      }
      
      if (!hasSeenAudio && Date.now() - startTime >= 2000) {
        console.log('[audio] No audio detected after 2s, assuming playback finished');
        if (audioMonitorIntervalRef.current) {
          clearInterval(audioMonitorIntervalRef.current);
          audioMonitorIntervalRef.current = null;
        }
        onAudioSilenceCallbackRef.current = null;
        onSilence();
        return;
      }

      if (Date.now() - startTime >= MAX_WAIT_FOR_SILENCE_MS) {
        console.log('[audio] Max wait time reached, proceeding anyway');
        if (audioMonitorIntervalRef.current) {
          clearInterval(audioMonitorIntervalRef.current);
          audioMonitorIntervalRef.current = null;
        }
        onAudioSilenceCallbackRef.current = null;
        onSilence();
      }
    }, 30);
  }, []);

  const endCall = useCallback(() => {
    if (endingCallRef.current) {
      console.log('[endCall] Already ending, skipping duplicate');
      return;
    }
    endingCallRef.current = true;

    if (audioMonitorIntervalRef.current) {
      clearInterval(audioMonitorIntervalRef.current);
      audioMonitorIntervalRef.current = null;
    }
    onAudioSilenceCallbackRef.current = null;

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
      analyserRef.current = null;
    }

    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }

    if (audioElementRef.current) {
      audioElementRef.current.srcObject = null;
      audioElementRef.current = null;
    }

    updateStatus('ended');
    addTranscript('system', 'Call ended');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateStatus, addTranscript]);

  const startCall = useCallback(async (
    systemPrompt?: string,
    voice: string = 'cedar',
    variableValues: Record<string, string> = {}
  ) => {
    if (!isSupported) {
      onErrorRef.current?.('Browser does not support audio recording');
      return;
    }

    try {
      updateStatus('connecting');
      addTranscript('system', 'Starting call...');
      console.log('[debug-call] startCall invoked', {
        hasSystemPrompt: Boolean(systemPrompt && systemPrompt.trim().length > 0),
        promptLength: systemPrompt?.length || 0,
        voice,
        variableKeys: Object.keys(variableValues || {}),
      });

      // Reset state
      latenciesRef.current = [];
      setLatency({ lastTurnMs: null, avgMs: null, turnCount: 0 });
      currentAssistantTextRef.current = '';
      goodbyeDetectedRef.current = false;
      endingCallRef.current = false;
      waitingForGoodbyeRef.current = false;
      inResponseRef.current = false;
      transcriptLengthRef.current = 0;
      hasAnyAssistantTranscriptRef.current = false;
      initialGreetingRetryCountRef.current = 0;
      if (initialGreetingWatchdogRef.current) {
        clearTimeout(initialGreetingWatchdogRef.current);
        initialGreetingWatchdogRef.current = null;
      }

      // 1. Get ephemeral token from our API (GA endpoint)
      const sessionResponse = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          systemPrompt: systemPrompt || '', 
          voice,
          variableValues,
        }),
      });
      console.log('[debug-call] /api/session response status:', sessionResponse.status, sessionResponse.statusText);

      if (!sessionResponse.ok) {
        const error = await sessionResponse.json();
        console.log('[debug-call] /api/session error payload:', JSON.stringify(error));
        console.log('[debug-call] OpenAI error details:', error.openaiError || error.details || 'none');
        throw new Error(error.error || 'Failed to create session');
      }

      const sessionData = await sessionResponse.json();
      const clientSecretValue = sessionData.client_secret?.value || sessionData.value;
      console.log('[debug-call] got client_secret:', {
        hasValue: Boolean(clientSecretValue),
        expiresAt: sessionData.client_secret?.expires_at || sessionData.expires_at,
      });
      
      if (!clientSecretValue) {
        console.error('[debug-call] No client_secret value found in response:', Object.keys(sessionData));
        throw new Error('No client secret returned from session endpoint');
      }

      // 2. Create peer connection
      const pc = new RTCPeerConnection();
      peerConnectionRef.current = pc;
      pc.onconnectionstatechange = () => {
        console.log('[debug-call] pc.connectionState:', pc.connectionState);
      };
      pc.oniceconnectionstatechange = () => {
        console.log('[debug-call] pc.iceConnectionState:', pc.iceConnectionState);
      };
      pc.onicegatheringstatechange = () => {
        console.log('[debug-call] pc.iceGatheringState:', pc.iceGatheringState);
      };

      // 3. Set up audio element for playback
      const audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.preload = 'auto';
      audioElementRef.current = audioEl;

      pc.ontrack = (event) => {
        const stream = event.streams[0];
        audioEl.srcObject = stream;
        
        audioEl.play().catch(err => {
          console.log('[audio] Autoplay blocked, user interaction required:', err);
        });
        
        try {
          const audioContext = new AudioContext();
          audioContextRef.current = audioContext;
          
          const source = audioContext.createMediaStreamSource(stream);
          const analyser = audioContext.createAnalyser();
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0.3;
          source.connect(analyser);
          analyserRef.current = analyser;
          
          console.log('[audio] Web Audio API analyser connected for silence detection');
        } catch (err) {
          console.log('[audio] Could not set up audio analyser:', err);
        }
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

      const audioTrack = stream.getAudioTracks()[0];
      stream.getTracks().forEach(track => {
        pc.addTrack(track, stream);
      });
      
      const updateMicMute = () => {
        if (audioTrack) {
          const shouldMute = assistantSpeakingRef.current;
          audioTrack.enabled = !shouldMute;
          console.log(`[mic] Track enabled: ${audioTrack.enabled} (assistant speaking: ${shouldMute})`);
          
          const channel = dataChannelRef.current;
          if (channel && channel.readyState === 'open') {
            try {
              channel.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
              console.log('[mic] Cleared server input audio buffer');
            } catch (_) { /* ignore */ }
          }
        }
      };

      // 5. Create data channel for events
      const dc = pc.createDataChannel('oai-events');
      dataChannelRef.current = dc;

      dc.onopen = () => {
        console.log('Data channel open');
        console.log('[debug-call] datachannel readyState:', dc.readyState);
        updateStatus('connected');
        addTranscript('system', 'Connected - call starting');

        const sendKickoffUserItem = (reason: string) => {
          if (dc.readyState !== 'open') return false;
          try {
            const kickoffPayload = {
              type: 'conversation.item.create',
              item: {
                type: 'message',
                role: 'user',
                content: [
                  {
                    type: 'input_text',
                    text: 'Start the call now with your greeting and first question.',
                  },
                ],
              },
            };
            console.log('[debug-call] sending kickoff conversation.item.create', { reason });
            dc.send(JSON.stringify(kickoffPayload));
            return true;
          } catch (err) {
            console.error('[debug-call] failed to send kickoff item:', err, { reason });
            return false;
          }
        };

        const sendResponseCreate = (reason: string, withInstruction: boolean = false) => {
          if (dc.readyState !== 'open') {
            console.log('[debug-call] skipped response.create; data channel not open', { reason, state: dc.readyState });
            return;
          }
          try {
            const responseObj: Record<string, unknown> = {};
            if (withInstruction) {
              responseObj.instructions = 'Begin now with the greeting and first script line.';
            }
            const payload: Record<string, unknown> = {
              type: 'response.create',
              ...(Object.keys(responseObj).length > 0 ? { response: responseObj } : {}),
            };
            console.log('[debug-call] sending response.create', { reason, withInstruction });
            dc.send(JSON.stringify(payload));
          } catch (sendErr) {
            console.error('[debug-call] failed to send response.create:', sendErr, { reason });
          }
        };
        
        setTimeout(() => {
          assistantSpeakingRef.current = true;
          updateMicMute();
          sendKickoffUserItem('initial-open');
          sendResponseCreate('initial-open');

          if (initialGreetingWatchdogRef.current) {
            clearTimeout(initialGreetingWatchdogRef.current);
          }
          initialGreetingWatchdogRef.current = window.setTimeout(() => {
            if (!hasAnyAssistantTranscriptRef.current && initialGreetingRetryCountRef.current < 1) {
              initialGreetingRetryCountRef.current += 1;
              console.log('[debug-call] initial greeting watchdog fired; retrying response.create');
              sendKickoffUserItem('initial-watchdog-retry');
              sendResponseCreate('initial-watchdog-retry', true);
            }
          }, 2500);
        }, 200);
      };

      dc.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          eventCountRef.current += 1;
          if (eventCountRef.current <= 25 || data.type === 'error') {
            console.log('[debug-call] incoming event', {
              idx: eventCountRef.current,
              type: data.type,
            });
          }
          handleServerEvent(data, updateMicMute, dc);
        } catch (e) {
          console.error('Failed to parse server event:', e);
        }
      };

      dc.onerror = (error) => {
        console.error('Data channel error:', error);
        onErrorRef.current?.('Connection error');
      };

      dc.onclose = () => {
        console.log('Data channel closed');
        if (endingCallRef.current) {
          return;
        }
        if (waitingForGoodbyeRef.current) {
          setTimeout(() => {
            if (!endingCallRef.current) {
              console.log('[fallback] Ending call after data channel close');
              endCall();
            }
          }, 2000);
          return;
        }
        endCall();
      };

      // 6. Create and set local description (offer)
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log('[debug-call] local offer set', {
        sdpLength: offer.sdp?.length || 0,
      });

      // 7. Send offer to OpenAI GA endpoint and get answer
      const sdpResponse = await fetch(
        'https://api.openai.com/v1/realtime/calls',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${clientSecretValue}`,
            'Content-Type': 'application/sdp',
          },
          body: offer.sdp,
        }
      );

      if (!sdpResponse.ok) {
        const sdpErrText = await sdpResponse.text();
        console.log('[debug-call] realtime SDP error body:', sdpErrText);
        throw new Error('Failed to connect to OpenAI Realtime');
      }

      const answerSdp = await sdpResponse.text();
      console.log('[debug-call] got answer SDP', { sdpLength: answerSdp?.length || 0 });
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      console.log('WebRTC connection established');

    } catch (error) {
      console.error('Call start error:', error);
      const message = error instanceof Error ? error.message : 'Failed to start call';
      onErrorRef.current?.(message);
      updateStatus('error');
      addTranscript('system', `Error: ${message}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSupported, updateStatus, addTranscript, endCall]);

  // Handle server events from data channel
  // Supports both beta and GA event names for graceful migration
  const handleServerEvent = useCallback((
    data: Record<string, unknown>,
    updateMicMute?: () => void,
    dataChannel?: RTCDataChannel
  ) => {
    const eventType = data.type as string;

    switch (eventType) {
      case 'session.created':
      case 'session.updated':
        break;

      case 'input_audio_buffer.speech_started':
        if (responseDelayTimerRef.current) {
          clearTimeout(responseDelayTimerRef.current);
          responseDelayTimerRef.current = null;
        }
        if (assistantSpeakingRef.current) {
          console.log('[mic] speech_started while assistant speaking — ignoring & clearing buffer');
          if (dataChannel && dataChannel.readyState === 'open') {
            try {
              dataChannel.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
            } catch (_) { /* ignore */ }
          }
          break;
        }
        updateStatus('user_speaking');
        break;

      case 'input_audio_buffer.speech_stopped':
        if (assistantSpeakingRef.current) {
          console.log('[debug-call] speech_stopped while assistant speaking — ignoring');
          break;
        }
        speechStoppedTimeRef.current = Date.now();
        updateStatus('processing');
        console.log('[debug-call] speech_stopped received (VAD auto-creates response)');
        break;

      case 'response.created':
        currentAssistantTextRef.current = '';
        if (responseDelayTimerRef.current) {
          clearTimeout(responseDelayTimerRef.current);
          responseDelayTimerRef.current = null;
        }
        assistantSpeakingRef.current = true;
        updateMicMute?.();
        console.log('[mic] Muted - response starting');
        break;

      // GA event names (primary)
      case 'response.output_audio_transcript.delta':
      // Beta fallback
      case 'response.audio_transcript.delta': {
        lastAudioDeltaTimeRef.current = Date.now();
        hasAnyAssistantTranscriptRef.current = true;
        if (initialGreetingWatchdogRef.current) {
          clearTimeout(initialGreetingWatchdogRef.current);
          initialGreetingWatchdogRef.current = null;
        }
        
        if (!inResponseRef.current) {
          inResponseRef.current = true;
          updateStatus('assistant_speaking');
          transcriptLengthRef.current = 0;
          
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
        }
        
        const delta = (data.delta as string) || '';
        currentAssistantTextRef.current += delta;
        transcriptLengthRef.current += delta.length;
        break;
      }

      // GA event name (primary)
      case 'response.output_audio_transcript.done':
      // Beta fallback
      case 'response.audio_transcript.done': {
        const transcript = (data.transcript as string) || currentAssistantTextRef.current;
        if (transcript) {
          hasAnyAssistantTranscriptRef.current = true;
          if (initialGreetingWatchdogRef.current) {
            clearTimeout(initialGreetingWatchdogRef.current);
            initialGreetingWatchdogRef.current = null;
          }
          addTranscript('assistant', transcript);
          
          if (containsFinalPhrase(transcript)) {
            console.log('[goodbye] Detected in transcript, will end after audio finishes');
            goodbyeDetectedRef.current = true;
          }
        }
        currentAssistantTextRef.current = '';
        break;
      }

      case 'response.done': {
        inResponseRef.current = false;
        
        const transcriptLen = transcriptLengthRef.current;
        const responseObj = data.response as any;
        let outputText = '';
        if (Array.isArray(responseObj?.output)) {
          for (const outItem of responseObj.output) {
            if (Array.isArray(outItem?.content)) {
              for (const c of outItem.content) {
                if (typeof c?.text === 'string' && c.text.trim()) {
                  outputText += (outputText ? ' ' : '') + c.text.trim();
                }
              }
            }
          }
        }
        if (!hasAnyAssistantTranscriptRef.current && outputText) {
          console.log('[debug-call] response.done had output text but no audio transcript');
          hasAnyAssistantTranscriptRef.current = true;
          addTranscript('assistant', outputText);
        }
        console.log('[debug-call] response.done received', {
          transcriptLen,
          hasAnyAssistantTranscript: hasAnyAssistantTranscriptRef.current,
          goodbyeDetected: goodbyeDetectedRef.current,
          responseStatus: responseObj?.status,
          outputItems: Array.isArray(responseObj?.output) ? responseObj.output.length : 0,
          outputTextLen: outputText.length,
        });

        if (!goodbyeDetectedRef.current && transcriptLen === 0 && !hasAnyAssistantTranscriptRef.current && dataChannel?.readyState === 'open') {
          if (initialGreetingRetryCountRef.current < 1) {
            initialGreetingRetryCountRef.current += 1;
            console.log('[debug-call] empty first response; retrying with kickoff item + response.create');
            try {
              dataChannel.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'message',
                  role: 'user',
                  content: [
                    {
                      type: 'input_text',
                      text: 'Start the call now with your greeting and first question.',
                    },
                  ],
                },
              }));
              dataChannel.send(JSON.stringify({
                type: 'response.create',
                response: {
                  instructions: 'Begin now with the greeting and first script line.',
                },
              }));
            } catch (sendErr) {
              console.error('[debug-call] failed retry after empty response.done:', sendErr);
            }
          }
        }
        
        if (goodbyeDetectedRef.current) {
          waitingForGoodbyeRef.current = true;
          const fallbackMs = Math.min(15000, Math.max(5000, transcriptLen * 80));
          waitForAudioSilence(() => {
            if (endingCallRef.current) return;
            endCall();
          }, fallbackMs);
        } else {
          const fallbackMs = Math.min(12000, Math.max(2000, transcriptLen * 80));
          waitForAudioSilence(() => {
            if (endingCallRef.current) return;
            assistantSpeakingRef.current = false;
            updateMicMute?.();
            updateStatus('listening');
          }, fallbackMs);
        }
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = (data.transcript as string) || '';
        if (transcript) {
          addTranscript('user', transcript);
        }
        break;
      }

      case 'error': {
        const errorData = data.error as { message?: string } | undefined;
        const errorMsg = errorData?.message || 'Unknown error';
        console.error('Server error:', errorMsg);
        onErrorRef.current?.(errorMsg);
        break;
      }

      default:
        break;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateStatus, addTranscript, endCall, waitForAudioSilence]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (initialGreetingWatchdogRef.current) {
        clearTimeout(initialGreetingWatchdogRef.current);
      }
      if (audioMonitorIntervalRef.current) {
        clearInterval(audioMonitorIntervalRef.current);
      }
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
      }
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
