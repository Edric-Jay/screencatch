
"use client";

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { AudioWaveform, Mic, Clapperboard, Video, StopCircle, Download, AlertTriangle, TimerIcon, CheckCircle2, Save, RefreshCwIcon } from 'lucide-react';

type RecordingStatus = "idle" | "permission_pending" | "countdown" | "recording" | "stopped" | "error" | "replay_buffering" | "replay_saving";

const REGULAR_RECORDING_DURATIONS = [
  { label: "Manual Stop (Unlimited)", value: 0 },
  { label: "1 Minute", value: 60 },
  { label: "3 Minutes", value: 180 },
  { label: "5 Minutes", value: 300 },
];

const INSTANT_REPLAY_CLIP_DURATIONS = [
  { label: "1 Minute", value: 60 },
  { label: "3 Minutes", value: 180 },
  { label: "5 Minutes", value: 300 },
];

const REPLAY_CHUNK_DURATION_MS = 5000; // 5 seconds per chunk
const REPLAY_CHUNK_DURATION_SECONDS = REPLAY_CHUNK_DURATION_MS / 1000;

export default function ScreenCatcherClient() {
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [includeSystemAudio, setIncludeSystemAudio] = useState(true);
  const [includeMicAudio, setIncludeMicAudio] = useState(false);
  const [regularRecordingDurationSeconds, setRegularRecordingDurationSeconds] = useState(0);

  const [recordedVideoUrl, setRecordedVideoUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);

  const [enableInstantReplay, setEnableInstantReplay] = useState(false);
  const [instantReplayBufferDuration, setInstantReplayBufferDuration] = useState(180); // Default to 3 minutes for buffer
  const instantReplayBufferDurationRef = useRef(instantReplayBufferDuration);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const replayBufferChunksRef = useRef<Blob[]>([]);

  const countdownTimerRef = useRef<NodeJS.Timeout | null>(null);
  const recordingStopTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const { toast } = useToast();

  useEffect(() => {
    instantReplayBufferDurationRef.current = instantReplayBufferDuration;
  }, [instantReplayBufferDuration]);

  const cleanupStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  }, []);

  const cleanupRecorder = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;
  }, []);

  const cleanupTimers = useCallback(() => {
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    if (recordingStopTimeoutRef.current) clearTimeout(recordingStopTimeoutRef.current);
    countdownTimerRef.current = null;
    recordingStopTimeoutRef.current = null;
    setCountdown(null);
  }, []);

  useEffect(() => {
    return () => {
      cleanupStream();
      cleanupRecorder();
      cleanupTimers();
      if (recordedVideoUrl) URL.revokeObjectURL(recordedVideoUrl);
      replayBufferChunksRef.current = [];
    };
  }, [cleanupStream, cleanupRecorder, cleanupTimers, recordedVideoUrl]);


  const handleStopRecording = useCallback(() => {
    if (mediaRecorderRef.current && (mediaRecorderRef.current.state === "recording" || mediaRecorderRef.current.state === "paused")) {
      mediaRecorderRef.current.stop();
    }
    cleanupTimers();
  }, [cleanupTimers]);

  const stopInstantReplayBuffering = useCallback((showToast = true) => {
    if (mediaRecorderRef.current && (mediaRecorderRef.current.state === "recording" || mediaRecorderRef.current.state === "paused")) {
        mediaRecorderRef.current.stop(); // This will trigger its onstop, which calls cleanupStream
    } else {
        cleanupStream(); // Explicitly cleanup if recorder wasn't active or didn't exist
        replayBufferChunksRef.current = [];
    }
    if (status !== "idle") {
      setStatus("idle");
    }
    if (showToast) {
      toast({ title: "Instant Replay Deactivated", icon: <RefreshCwIcon className="h-5 w-5" /> });
    }
  }, [status, toast, cleanupStream, setStatus]);


  // Not using useCallback here to ensure it captures the latest state/refs in its closure
  // This function is assigned to streamRef.current.getVideoTracks()[0].onended
  function handleStreamStopFromBrowser() {
    if (status === "recording" || status === "countdown") {
      console.log("Screen sharing stopped by user (regular recording).");
      handleStopRecording(); // handleStopRecording is stable due to useCallback
    } else if (status === "replay_buffering") {
      console.log("Screen sharing stopped by user (replay buffering).");
      stopInstantReplayBuffering(false); // stopInstantReplayBuffering is stable
      setEnableInstantReplay(false); // Direct state update
      // No explicit toast here if stopInstantReplayBuffering(false) is used.
      // A toast might be desired if user explicitly stops sharing via browser UI
      if (status !== "idle") { // Check if status was not already idle to avoid redundant toasts
         toast({ title: "Instant Replay Stopped", description: "Screen sharing was ended.", variant: "default" });
      }
    }
  };


  const startRecordingSharedLogic = async (forReplay: boolean): Promise<boolean> => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      setErrorMessage("Screen recording is not supported by your browser.");
      setStatus("error");
      toast({ title: "Error", description: "Screen recording not supported.", variant: "destructive" });
      return false;
    }

    setStatus("permission_pending");
    setErrorMessage(null);
    if (recordedVideoUrl && !forReplay) URL.revokeObjectURL(recordedVideoUrl);
    if (!forReplay) setRecordedVideoUrl(null);

    recordedChunksRef.current = [];
    if(forReplay) replayBufferChunksRef.current = [];


    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: includeSystemAudio,
      });

      let finalStream = displayStream;

      if (includeMicAudio) {
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          micStream.getAudioTracks().forEach(track => finalStream.addTrack(track.clone()));
        } catch (micError) {
          console.error("Error accessing microphone:", micError);
          toast({ title: "Microphone Error", description: "Could not access microphone. Recording without mic audio.", variant: "destructive" });
        }
      }

      streamRef.current = finalStream;
      // Assign the regular function, not a useCallback version here for simplicity and to avoid re-hooking.
      finalStream.getVideoTracks()[0].onended = handleStreamStopFromBrowser;


      const options = { mimeType: 'video/webm; codecs=vp9' };
      try {
        mediaRecorderRef.current = new MediaRecorder(finalStream, options);
      } catch (e) {
        console.warn("vp9 codec not supported, falling back to default");
        mediaRecorderRef.current = new MediaRecorder(finalStream);
      }

      return true;

    } catch (err) {
      console.error("Error starting recording:", err);
      const typedError = err as Error;
      if (typedError.name === "NotAllowedError") {
        setErrorMessage("Permission to record screen was denied. Please allow access and try again.");
        toast({ title: "Permission Denied", description: "Screen recording permission was denied.", variant: "destructive" });
      } else {
        setErrorMessage(`An error occurred: ${typedError.message}`);
        toast({ title: "Recording Error", description: typedError.message, variant: "destructive" });
      }
      setStatus("error");
      cleanupStream();
      if (forReplay) setEnableInstantReplay(false);
      return false;
    }
  };

  const handleStartRecording = async () => {
    if (enableInstantReplay) {
      toast({ title: "Action disabled", description: "Disable Instant Replay to start a regular recording.", variant: "default" });
      return;
    }
    const success = await startRecordingSharedLogic(false);
    if (!success || !mediaRecorderRef.current) return;

    mediaRecorderRef.current.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunksRef.current.push(event.data);
      }
    };

    mediaRecorderRef.current.onstop = () => {
      if (recordedChunksRef.current.length === 0 && status !== "idle") { // Ensure not to process if already idle (e.g. from user stop)
        setStatus("idle");
        cleanupStream();
        cleanupTimers();
        console.log("Recording stopped with no data (regular).");
        return;
      }
      if (recordedChunksRef.current.length > 0) {
        const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        setRecordedVideoUrl(url);
        toast({ title: "Recording Finished", description: "Your video is ready for download.", icon: <CheckCircle2 className="h-5 w-5 text-green-500" /> });
      }
      setStatus("stopped"); // Transition to stopped even if no chunks, to show video player or message
      cleanupStream();
      cleanupTimers();
      recordedChunksRef.current = [];
    };

    mediaRecorderRef.current.start(); // Continuous recording for regular mode

    if (regularRecordingDurationSeconds > 0) {
      setStatus("countdown");
      setCountdown(regularRecordingDurationSeconds);
      countdownTimerRef.current = setInterval(() => {
        setCountdown(prev => (prev !== null && prev > 0 ? prev - 1 : 0));
      }, 1000);
      recordingStopTimeoutRef.current = setTimeout(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
          mediaRecorderRef.current.stop();
        }
      }, regularRecordingDurationSeconds * 1000);
    } else {
      setStatus("recording");
    }
    toast({ title: "Regular Recording Started", icon: <Video className="h-5 w-5 text-red-500" /> });
  };


  // --- Instant Replay Logic ---
  const startInstantReplayBuffering = async () => {
    if (status === "recording" || status === "countdown") {
        toast({title: "Action disabled", description: "Stop regular recording to enable Instant Replay.", variant: "default"});
        setEnableInstantReplay(false);
        return;
    }
    const success = await startRecordingSharedLogic(true);
    if (!success || !mediaRecorderRef.current) {
        setEnableInstantReplay(false);
        return;
    }

    mediaRecorderRef.current.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
            replayBufferChunksRef.current.push(event.data);
            // Use the ref for currentBufferDurationTarget to get the latest value
            const currentBufferDurationTarget = instantReplayBufferDurationRef.current;
            const maxChunks = Math.ceil(currentBufferDurationTarget / REPLAY_CHUNK_DURATION_SECONDS);
            while (replayBufferChunksRef.current.length > maxChunks) {
                replayBufferChunksRef.current.shift();
            }
        }
    };

    mediaRecorderRef.current.onstop = () => {
        cleanupStream(); // Always clean up the stream when the recorder stops
        if (status === "replay_buffering") { // Only change status if it was actively buffering
          setStatus("idle");
          // If onstop was called NOT due to saving, but e.g. stream ended, clear chunks
          if(status !== "replay_saving") replayBufferChunksRef.current = [];
        }
        // If it stopped while 'replay_saving', handleSaveLastClip will set the next status
    };

    mediaRecorderRef.current.onerror = (event) => {
        console.error("MediaRecorder error (replay):", event);
        setErrorMessage("An error occurred with the replay buffer.");
        setStatus("error");
        stopInstantReplayBuffering(true);
        setEnableInstantReplay(false);
    };

    mediaRecorderRef.current.start(REPLAY_CHUNK_DURATION_MS); // Collect data in 5-second chunks
    setStatus("replay_buffering");
    toast({ title: "Instant Replay Active", description: `Buffering up to ${instantReplayBufferDurationRef.current / 60} min.`, icon: <RefreshCwIcon className="h-5 w-5 text-blue-500" /> });
  };


  const handleToggleInstantReplay = (checked: boolean) => {
    setEnableInstantReplay(checked);
    if (checked) {
        startInstantReplayBuffering();
    } else {
        stopInstantReplayBuffering(true);
    }
  };

  const handleSaveLastClip = () => {
    if (replayBufferChunksRef.current.length === 0) {
        toast({ title: "Buffer Empty", description: "No replay data buffered yet.", variant: "default" });
        return;
    }
    setStatus("replay_saving");

    // This is the duration selected in the UI for the clip (e.g., "Save Last 1 Minute")
    const desiredClipDurationSeconds = instantReplayBufferDurationRef.current;
    // Calculate how many of our 5-second chunks make up this desired duration
    const numberOfChunksToSave = Math.max(1, Math.ceil(desiredClipDurationSeconds / REPLAY_CHUNK_DURATION_SECONDS));
    
    // Slice the replayBufferChunksRef to get only the most recent chunks for the desired clip duration
    const chunksForClip = replayBufferChunksRef.current.slice(-numberOfChunksToSave);

    if (chunksForClip.length === 0) {
        // This case should ideally not be hit if replayBufferChunksRef.current.length > 0 check passed,
        // but as a safeguard.
        toast({ title: "Buffer Incomplete", description: "Not enough data for the selected duration. Try a shorter clip or wait longer.", variant: "default" });
        setStatus(enableInstantReplay ? "replay_buffering" : "idle"); // Revert status
        return;
    }

    const blob = new Blob(chunksForClip, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `ScreenCatcher-InstantReplay-${new Date().toISOString()}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // It's good practice to revoke the object URL after a short delay or when it's no longer needed
    // For downloads, revoking immediately can sometimes cause issues in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 100);


    toast({ title: "Replay Saved!", description: `Last clip (up to ${desiredClipDurationSeconds / 60} min) saved.`, icon: <Download className="h-5 w-5 text-green-500" /> });
    
    // After saving, decide next state
    if (enableInstantReplay) {
        // If replay is still enabled and stream is active, it should ideally continue buffering.
        // The mediaRecorder might have stopped if its ondataavailable was too slow or if saving somehow interrupted it.
        // We also need to consider if the stream itself is still active.
        if (streamRef.current && streamRef.current.active && mediaRecorderRef.current && mediaRecorderRef.current.state === 'inactive') {
            // If recorder is inactive but stream is fine, and replay is enabled, restart buffering.
            // This covers the case where saving might have stopped the recorder.
            // To be safe, we'll clear old chunks and restart.
            replayBufferChunksRef.current = [];
            mediaRecorderRef.current.start(REPLAY_CHUNK_DURATION_MS);
            setStatus("replay_buffering");
        } else if (streamRef.current && streamRef.current.active) {
            // If recorder is already active (e.g. ondataavailable continued), just set status.
             setStatus("replay_buffering");
        } else {
            // Stream might have been stopped by user action during save or other reasons.
            setEnableInstantReplay(false); // Turn off toggle if stream died
            setStatus("idle");
            stopInstantReplayBuffering(false); // Ensure full cleanup if stream died
            toast({ title: "Instant Replay Deactivated", description: "Screen sharing ended.", icon: <RefreshCwIcon className="h-5 w-5" /> });
        }
    } else {
        setStatus("idle");
        // If instant replay was disabled before/during saving, ensure buffer is cleared.
        replayBufferChunksRef.current = [];
        stopInstantReplayBuffering(false); // Full cleanup
    }
  };

  const formatTime = (totalSeconds: number | null) => {
    if (totalSeconds === null) return "00:00";
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  };

  const isRegularRecordingActive = status === "recording" || status === "countdown" || (status === "permission_pending" && !enableInstantReplay);
  const isInstantReplayActiveAndNotSaving = status === "replay_buffering" || (status === "permission_pending" && enableInstantReplay);


  return (
    <Card className="w-full max-w-lg mx-auto shadow-2xl">
      <CardHeader>
        <CardTitle className="flex items-center text-3xl font-headline">
          <Clapperboard className="mr-3 h-8 w-8 text-primary" />
          ScreenCatcher
        </CardTitle>
        <CardDescription>
          Record your screen, window, or tab. Or, enable Instant Replay to save the last few minutes of your screen activity.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {errorMessage && (
          <Alert variant="destructive" className="animate-pulse">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-4 p-4 border rounded-md bg-card-foreground/5">
          <h3 className="text-lg font-medium text-foreground">Audio Options</h3>
          <div className="flex items-center justify-between">
            <Label htmlFor="system-audio" className="flex items-center">
              <AudioWaveform className="mr-2 h-5 w-5 text-accent" />
              Include System/Tab Audio
            </Label>
            <Switch
              id="system-audio"
              checked={includeSystemAudio}
              onCheckedChange={setIncludeSystemAudio}
              disabled={isRegularRecordingActive || isInstantReplayActiveAndNotSaving || status === 'replay_saving'}
              aria-label="Toggle system audio"
            />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="mic-audio" className="flex items-center">
              <Mic className="mr-2 h-5 w-5 text-accent" />
              Include Microphone Audio
            </Label>
            <Switch
              id="mic-audio"
              checked={includeMicAudio}
              onCheckedChange={setIncludeMicAudio}
              disabled={isRegularRecordingActive || isInstantReplayActiveAndNotSaving || status === 'replay_saving'}
              aria-label="Toggle microphone audio"
            />
          </div>
        </div>

        <div className="space-y-4 p-4 border rounded-md bg-card-foreground/5">
            <h3 className="text-lg font-medium text-foreground">Regular Recording</h3>
            <div className="space-y-1.5">
                <Label htmlFor="duration" className="flex items-center">
                <TimerIcon className="mr-2 h-5 w-5 text-accent" />
                Max Recording Duration
                </Label>
                <Select
                value={String(regularRecordingDurationSeconds)}
                onValueChange={(value) => setRegularRecordingDurationSeconds(parseInt(value,10))}
                disabled={isRegularRecordingActive || enableInstantReplay}
                >
                <SelectTrigger id="duration" aria-label="Select maximum recording duration">
                    <SelectValue placeholder="Select duration" />
                </SelectTrigger>
                <SelectContent>
                    {REGULAR_RECORDING_DURATIONS.map(d => (
                    <SelectItem key={d.value} value={String(d.value)}>{d.label}</SelectItem>
                    ))}
                </SelectContent>
                </Select>
            </div>
            <div className="flex flex-col items-center space-y-4 mt-4">
                {isRegularRecordingActive && (status === "recording" || status === "countdown") ? (
                    <Button
                    onClick={handleStopRecording}
                    variant="destructive"
                    size="lg"
                    className="w-full transition-all duration-300 ease-in-out transform hover:scale-105"
                    aria-label="Stop recording"
                    >
                    <StopCircle className="mr-2 h-5 w-5" />
                    Stop Recording
                    </Button>
                ) : (
                    <Button
                    onClick={handleStartRecording}
                    size="lg"
                    className="w-full bg-primary hover:bg-primary/90 text-primary-foreground transition-all duration-300 ease-in-out transform hover:scale-105"
                    disabled={isRegularRecordingActive || enableInstantReplay || (status === "permission_pending" && !enableInstantReplay) || status === "replay_saving"}
                    aria-label="Start recording"
                    >
                    <Video className="mr-2 h-5 w-5" />
                    {status === "permission_pending" && !enableInstantReplay ? "Waiting for Permission..." : "Start Recording"}
                    </Button>
                )}
                 <div className="text-sm text-muted-foreground h-5">
                    {status === "countdown" && `Time left: ${formatTime(countdown)}`}
                    {status === "recording" && regularRecordingDurationSeconds === 0 && "Recording (Manual Stop)..."}
                    {status === "recording" && regularRecordingDurationSeconds > 0 && `Recording... ${formatTime(countdown)}`}
                 </div>
            </div>
        </div>

        <div className="space-y-4 p-4 border rounded-md bg-card-foreground/5">
            <h3 className="text-lg font-medium text-foreground">Instant Replay</h3>
            <div className="flex items-center justify-between">
                <Label htmlFor="instant-replay-enable" className="flex items-center">
                    <RefreshCwIcon className="mr-2 h-5 w-5 text-accent" />
                    Enable Instant Replay
                </Label>
                <Switch
                    id="instant-replay-enable"
                    checked={enableInstantReplay}
                    onCheckedChange={handleToggleInstantReplay}
                    disabled={isRegularRecordingActive || (status === "permission_pending" && !enableInstantReplay) || status === 'replay_saving'}
                    aria-label="Toggle Instant Replay"
                />
            </div>
            {enableInstantReplay && (
                <>
                    <div className="space-y-1.5">
                        <Label htmlFor="replay-duration" className="flex items-center">
                        <TimerIcon className="mr-2 h-5 w-5 text-accent" />
                        Replay Clip Duration
                        </Label>
                        <Select
                            value={String(instantReplayBufferDuration)}
                            onValueChange={(value) => setInstantReplayBufferDuration(parseInt(value,10))}
                            disabled={status === "replay_saving" || (status === "permission_pending" && enableInstantReplay)}
                        >
                        <SelectTrigger id="replay-duration" aria-label="Select replay clip duration">
                            <SelectValue placeholder="Select duration" />
                        </SelectTrigger>
                        <SelectContent>
                            {INSTANT_REPLAY_CLIP_DURATIONS.map(d => (
                            <SelectItem key={d.value} value={String(d.value)}>{d.label}</SelectItem>
                            ))}
                        </SelectContent>
                        </Select>
                    </div>
                    <Button
                        onClick={handleSaveLastClip}
                        size="lg"
                        className="w-full bg-accent hover:bg-accent/90 text-accent-foreground transition-all"
                        disabled={status !== "replay_buffering" || replayBufferChunksRef.current.length === 0}
                        aria-label={`Save last ${instantReplayBufferDuration / 60} minutes`}
                        >
                        <Save className="mr-2 h-5 w-5" />
                        Save Last {instantReplayBufferDuration / 60} Minute(s)
                    </Button>
                </>
            )}
            <div className="text-sm text-muted-foreground h-5 text-center">
                {status === "replay_buffering" && `Buffering up to ${instantReplayBufferDurationRef.current/60} min...`}
                {status === "replay_saving" && `Saving replay...`}
                {status === "permission_pending" && enableInstantReplay && "Awaiting permission for Instant Replay..."}
            </div>
        </div>


        <div className="text-sm text-muted-foreground h-5 text-center">
            {status === "stopped" && recordedChunksRef.current.length === 0 && "Recording stopped. No video data was captured."}
            {status === "stopped" && recordedChunksRef.current.length > 0 && "Recording finished!"}
            {status === "idle" && !enableInstantReplay && "Ready to record."}
        </div>

        {recordedVideoUrl && status === "stopped" && (
          <div className="space-y-4 p-4 border rounded-md bg-card-foreground/5 animate-fadeIn">
            <h3 className="text-lg font-medium text-foreground">Recording Complete</h3>
            <video src={recordedVideoUrl} controls className="w-full rounded-md shadow-md" />
            <Button
              onClick={() => {
                const a = document.createElement('a');
                a.href = recordedVideoUrl;
                a.download = `ScreenCatcher-recording-${new Date().toISOString()}.webm`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                toast({ title: "Download Started", description: "Your recording is downloading." });
              }}
              className="w-full bg-accent hover:bg-accent/90 text-accent-foreground transition-all"
              aria-label="Download recording"
            >
              <Download className="mr-2 h-5 w-5" />
              Download Recording (.webm)
            </Button>
          </div>
        )}
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground text-center block">
        <p>&copy; {new Date().getFullYear()} ScreenCatcher. Ensure you have necessary permissions before recording.</p>
        <p>Recordings are processed locally in your browser and are not uploaded.</p>
      </CardFooter>
    </Card>
  );
}


