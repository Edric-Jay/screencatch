
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

export default function ScreenCatcherClient() {
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [includeSystemAudio, setIncludeSystemAudio] = useState(true);
  const [includeMicAudio, setIncludeMicAudio] = useState(false);
  const [regularRecordingDurationSeconds, setRegularRecordingDurationSeconds] = useState(0); // Default to Manual Stop

  const [recordedVideoUrl, setRecordedVideoUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);

  const [enableInstantReplay, setEnableInstantReplay] = useState(false);
  const [instantReplayBufferDuration, setInstantReplayBufferDuration] = useState(180); // Default 3 minutes for replay

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]); // For regular recording
  const replayBufferChunksRef = useRef<Blob[]>([]); // For instant replay

  const countdownTimerRef = useRef<NodeJS.Timeout | null>(null);
  const recordingStopTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const { toast } = useToast();

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

  const handleStreamStopFromBrowser = useCallback(() => {
    if (status === "recording" || status === "countdown") {
      console.log("Screen sharing stopped by user (regular recording).");
      handleStopRecording(); // This will call cleanup and set status
    } else if (status === "replay_buffering") {
      console.log("Screen sharing stopped by user (replay buffering).");
      stopInstantReplayBuffering(false); // Pass false to not try to show toast if component is unmounting
      setEnableInstantReplay(false); 
      if (status !== "idle") { // Avoid toast if already idle (e.g. during unmount cleanup)
         toast({ title: "Instant Replay Stopped", description: "Screen sharing was ended.", variant: "default" });
      }
    }
  }, [status, toast]);


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
      if (recordedChunksRef.current.length === 0) {
        setStatus("idle"); // Or 'stopped' if a brief recording was intended but yielded no data
        cleanupStream();
        cleanupTimers();
        console.log("Recording stopped with no data.");
        return;
      }
      const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      setRecordedVideoUrl(url);
      setStatus("stopped");
      cleanupStream();
      cleanupTimers();
      recordedChunksRef.current = [];
      toast({ title: "Recording Finished", description: "Your video is ready for download.", icon: <CheckCircle2 className="h-5 w-5 text-green-500" /> });
    };
    
    mediaRecorderRef.current.start();
    
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

  const handleStopRecording = useCallback(() => {
    if (mediaRecorderRef.current && (mediaRecorderRef.current.state === "recording" || mediaRecorderRef.current.state === "paused")) {
      mediaRecorderRef.current.stop();
    }
    cleanupTimers();
    // onstop handler will set status
  }, [cleanupTimers]);


  // --- Instant Replay Logic ---
  const startInstantReplayBuffering = async () => {
    if (status === "recording" || status === "countdown") {
        toast({title: "Action disabled", description: "Stop regular recording to enable Instant Replay.", variant: "default"});
        setEnableInstantReplay(false);
        return;
    }
    const success = await startRecordingSharedLogic(true);
    if (!success || !mediaRecorderRef.current) {
        setEnableInstantReplay(false); // Ensure switch is off if permission failed
        return;
    }

    mediaRecorderRef.current.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
            replayBufferChunksRef.current.push(event.data);
            const maxChunks = instantReplayBufferDuration; // Assumes 1 chunk per second
            while (replayBufferChunksRef.current.length > maxChunks) {
                replayBufferChunksRef.current.shift();
            }
        }
    };

    mediaRecorderRef.current.onstop = () => { // Primarily for cleanup if stopped unexpectedly
        cleanupStream();
        if (status === "replay_buffering") { // only set to idle if it was previously buffering. Avoids state clash on unmount.
          setStatus("idle");
        }
        replayBufferChunksRef.current = []; // Clear buffer on stop
    };
    
    mediaRecorderRef.current.onerror = (event) => {
        console.error("MediaRecorder error (replay):", event);
        setErrorMessage("An error occurred with the replay buffer.");
        setStatus("error");
        stopInstantReplayBuffering(true);
        setEnableInstantReplay(false);
    };

    mediaRecorderRef.current.start(1000); // 1-second chunks
    setStatus("replay_buffering");
    toast({ title: "Instant Replay Active", description: `Buffering last ${instantReplayBufferDuration / 60} min.`, icon: <RefreshCwIcon className="h-5 w-5 text-blue-500" /> });
  };

  const stopInstantReplayBuffering = useCallback((showToast = true) => {
    if (mediaRecorderRef.current && (mediaRecorderRef.current.state === "recording" || mediaRecorderRef.current.state === "paused")) {
        mediaRecorderRef.current.stop(); // This will trigger onstop, cleaning up stream and chunks
    } else {
        // If no recorder active, still ensure stream is cleaned if it exists (e.g. permission granted but recording not started)
        cleanupStream();
        replayBufferChunksRef.current = [];
    }
    if (status !== "idle") { // Avoid setting to idle if already idle (e.g. from unmount)
      setStatus("idle");
    }
    if (showToast) {
      toast({ title: "Instant Replay Deactivated", icon: <RefreshCwIcon className="h-5 w-5" /> });
    }
  }, [status, toast, cleanupStream]);

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
    const blob = new Blob(replayBufferChunksRef.current, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `ScreenCatcher-InstantReplay-${new Date().toISOString()}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url); // Revoke immediately after click initiated

    toast({ title: "Replay Saved!", description: `Last ${instantReplayBufferDuration / 60} minute(s) saved.`, icon: <Download className="h-5 w-5 text-green-500" /> });
    setStatus("replay_buffering"); // Return to buffering state
  };

  const formatTime = (totalSeconds: number | null) => {
    if (totalSeconds === null) return "00:00";
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  };

  const isRegularRecordingActive = status === "recording" || status === "countdown" || status === "permission_pending" && !enableInstantReplay;
  const isInstantReplayActive = status === "replay_buffering" || status === "replay_saving" || status === "permission_pending" && enableInstantReplay;


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

        {/* Audio Options */}
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
              disabled={isRegularRecordingActive || isInstantReplayActive}
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
              disabled={isRegularRecordingActive || isInstantReplayActive}
              aria-label="Toggle microphone audio"
            />
          </div>
        </div>

        {/* Regular Recording Section */}
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
                    disabled={isRegularRecordingActive || enableInstantReplay || status === "permission_pending"}
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
        
        {/* Instant Replay Section */}
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
                    disabled={isRegularRecordingActive || status === "permission_pending"}
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
                            disabled={status === "replay_buffering" || status === "replay_saving" || status === "permission_pending"}
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
                {status === "replay_buffering" && `Buffering for Instant Replay... (last ${instantReplayBufferDuration/60} min)`}
                {status === "replay_saving" && `Saving replay...`}
                {status === "permission_pending" && enableInstantReplay && "Awaiting permission for Instant Replay..."}
            </div>
        </div>


        <div className="text-sm text-muted-foreground h-5 text-center">
            {status === "stopped" && "Recording finished!"}
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


    