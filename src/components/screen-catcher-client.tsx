"use client";

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { AudioWaveform, Mic, Clapperboard, Video, StopCircle, Download, AlertTriangle, TimerIcon, CheckCircle2 } from 'lucide-react';

type RecordingStatus = "idle" | "permission_pending" | "countdown" | "recording" | "stopped" | "error";

const DURATIONS = [
  { label: "Manual Stop", value: 0 },
  { label: "1 Minute", value: 60 },
  { label: "3 Minutes", value: 180 },
];

export default function ScreenCatcherClient() {
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [includeSystemAudio, setIncludeSystemAudio] = useState(true);
  const [includeMicAudio, setIncludeMicAudio] = useState(false);
  const [maxDurationSeconds, setMaxDurationSeconds] = useState(180); // Default to 3 minutes
  
  const [recordedVideoUrl, setRecordedVideoUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
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
    recordedChunksRef.current = [];
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
    };
  }, [cleanupStream, cleanupRecorder, cleanupTimers, recordedVideoUrl]);

  const handleStartRecording = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      setErrorMessage("Screen recording is not supported by your browser.");
      setStatus("error");
      toast({ title: "Error", description: "Screen recording not supported.", variant: "destructive" });
      return;
    }

    setStatus("permission_pending");
    setErrorMessage(null);
    if (recordedVideoUrl) URL.revokeObjectURL(recordedVideoUrl);
    setRecordedVideoUrl(null);
    recordedChunksRef.current = [];

    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: includeSystemAudio, // system audio or tab audio
      });

      let finalStream = displayStream;

      if (includeMicAudio) {
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          micStream.getAudioTracks().forEach(track => finalStream.addTrack(track.clone())); // Clone to avoid issues if micStream is stopped elsewhere
        } catch (micError) {
          console.error("Error accessing microphone:", micError);
          toast({ title: "Microphone Error", description: "Could not access microphone. Recording without mic audio.", variant: "destructive" });
          // Continue without mic audio
        }
      }
      
      streamRef.current = finalStream;

      // Listen for when the user stops sharing via browser UI
      finalStream.getVideoTracks()[0].onended = () => {
        console.log("Screen sharing stopped by user via browser UI.");
        handleStopRecording();
      };

      const options = { mimeType: 'video/webm; codecs=vp9' }; // Prioritize vp9 for better quality/compression
      try {
        mediaRecorderRef.current = new MediaRecorder(finalStream, options);
      } catch (e) {
        console.warn("vp9 codec not supported, falling back to default");
        mediaRecorderRef.current = new MediaRecorder(finalStream); // Fallback
      }
      
      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      mediaRecorderRef.current.onstop = () => {
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
      
      if (maxDurationSeconds > 0) {
        setStatus("countdown");
        setCountdown(maxDurationSeconds);
        countdownTimerRef.current = setInterval(() => {
          setCountdown(prev => (prev !== null && prev > 0 ? prev - 1 : 0));
        }, 1000);
        recordingStopTimeoutRef.current = setTimeout(() => {
          if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.stop();
          }
        }, maxDurationSeconds * 1000);
      } else {
        setStatus("recording");
      }
      toast({ title: "Recording Started", icon: <Video className="h-5 w-5 text-red-500" /> });

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
      cleanupStream(); // Ensure stream is cleaned up on error
    }
  };

  const handleStopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
      // onstop handler will set status to "stopped"
    } else if (mediaRecorderRef.current && mediaRecorderRef.current.state === "paused") {
        mediaRecorderRef.current.stop(); // If somehow paused
    }
    // If streamRef.current exists, its tracks are stopped in onstop or if user stops sharing
    cleanupTimers();
    // setStatus("idle"); // onstop will set it to "stopped"
  }, [cleanupTimers]);


  const handleDurationChange = (value: string) => {
    setMaxDurationSeconds(parseInt(value, 10));
  };

  const formatTime = (totalSeconds: number | null) => {
    if (totalSeconds === null) return "00:00";
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  };

  return (
    <Card className="w-full max-w-lg mx-auto shadow-2xl">
      <CardHeader>
        <CardTitle className="flex items-center text-3xl font-headline">
          <Clapperboard className="mr-3 h-8 w-8 text-primary" />
          ScreenCatcher
        </CardTitle>
        <CardDescription>
          Record your screen, window, or tab with custom audio and duration. Your browser will prompt you to select the recording source.
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
          <h3 className="text-lg font-medium text-foreground">Recording Options</h3>
          <div className="flex items-center justify-between">
            <Label htmlFor="system-audio" className="flex items-center">
              <AudioWaveform className="mr-2 h-5 w-5 text-accent" />
              Include System/Tab Audio
            </Label>
            <Switch
              id="system-audio"
              checked={includeSystemAudio}
              onCheckedChange={setIncludeSystemAudio}
              disabled={status === "recording" || status === "countdown" || status === "permission_pending"}
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
              disabled={status === "recording" || status === "countdown" || status === "permission_pending"}
              aria-label="Toggle microphone audio"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="duration" className="flex items-center">
              <TimerIcon className="mr-2 h-5 w-5 text-accent" />
              Max Recording Duration
            </Label>
            <Select
              value={String(maxDurationSeconds)}
              onValueChange={handleDurationChange}
              disabled={status === "recording" || status === "countdown" || status === "permission_pending"}
            >
              <SelectTrigger id="duration" aria-label="Select maximum recording duration">
                <SelectValue placeholder="Select duration" />
              </SelectTrigger>
              <SelectContent>
                {DURATIONS.map(d => (
                  <SelectItem key={d.value} value={String(d.value)}>{d.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-col items-center space-y-4">
          {(status === "recording" || status === "countdown") ? (
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
              disabled={status === "permission_pending"}
              aria-label="Start recording"
            >
              <Video className="mr-2 h-5 w-5" />
              {status === "permission_pending" ? "Waiting for Permission..." : "Start Recording"}
            </Button>
          )}
          
          <div className="text-sm text-muted-foreground h-5">
            {status === "countdown" && `Time left: ${formatTime(countdown)}`}
            {status === "recording" && maxDurationSeconds === 0 && "Recording... (Manual Stop)"}
            {status === "recording" && maxDurationSeconds > 0 && `Recording... ${formatTime(countdown)}`}
            {status === "stopped" && "Recording finished!"}
            {status === "permission_pending" && "Awaiting screen share permission..."}
            {status === "idle" && "Ready to record."}
          </div>
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
