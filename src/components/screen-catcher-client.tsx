
"use client";

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { AudioWaveform, Mic, Clapperboard, Video, StopCircle, Download, AlertTriangle, CheckCircle2, Save } from 'lucide-react';

type RecordingStatus = "idle" | "permission_pending" | "recording" | "stopped_pending_full_download" | "error";

const MAIN_RECORDING_CHUNK_DURATION_MS = 1000; // 1 second chunks for main recording

const LIVE_CLIP_DURATIONS = [
  { label: "Last 30 Seconds", value: 30 },
  { label: "Last 1 Minute", value: 60 },
  { label: "Last 3 Minutes", value: 180 },
  { label: "Last 5 Minutes", value: 300 },
];

export default function ScreenCatcherClient() {
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [includeSystemAudio, setIncludeSystemAudio] = useState(true);
  const [includeMicAudio, setIncludeMicAudio] = useState(false);
  const [recordedVideoUrl, setRecordedVideoUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [numRecordedChunks, setNumRecordedChunks] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const chosenMimeTypeRef = useRef<string>('video/webm');


  const { toast } = useToast();

  const isRecordingInProgress = status === "recording";
  const isPermissionPending = status === "permission_pending";
  const showDownloadOptions = status === "stopped_pending_full_download";

  const cleanupStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  }, []);

  const cleanupRecorder = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try {
        mediaRecorderRef.current.stop();
      } catch (e) {
        console.warn("Error stopping media recorder during cleanup:", e);
      }
    }
    mediaRecorderRef.current = null;
  }, []);

  const cleanupFullRecordingState = useCallback(() => {
    cleanupStream();
    cleanupRecorder();
    recordedChunksRef.current = [];
    if (recordedVideoUrl) {
      URL.revokeObjectURL(recordedVideoUrl);
      setRecordedVideoUrl(null);
    }
    setNumRecordedChunks(0);
  }, [cleanupStream, cleanupRecorder, recordedVideoUrl]);


  const handleStopRecording = useCallback(() => {
    console.log("handleStopRecording called. Current status:", status);
    if (mediaRecorderRef.current) {
      if (mediaRecorderRef.current.state === "recording" || mediaRecorderRef.current.state === "paused") {
        try {
          console.log("Attempting to stop media recorder.");
          mediaRecorderRef.current.stop(); // onstop will handle further state changes
          // Toast is handled in onstop
        } catch (error) {
          console.error("Error explicitly stopping MediaRecorder:", error);
          toast({ title: "Error Stopping", description: "Could not stop recorder. Please refresh.", variant: "destructive" });
          cleanupFullRecordingState(); // Force cleanup
          setStatus("error");
          setErrorMessage("Error stopping recorder. State has been reset.");
        }
      } else {
        console.warn("Stop called but recorder not in recording/paused state:", mediaRecorderRef.current.state);
        // If not recording, but somehow in a stop state, ensure UI consistency
        if (status !== "idle" && status !== "error" && status !== "stopped_pending_full_download") {
          cleanupFullRecordingState();
          setStatus("idle");
        }
      }
    } else {
      console.warn("handleStopRecording called but no mediaRecorderRef.current");
      if (status !== "idle" && status !== "error" && status !== "stopped_pending_full_download") {
         cleanupFullRecordingState();
         setStatus("idle");
      }
    }
  }, [status, toast, cleanupFullRecordingState]);


  const handleStreamStopFromBrowser = useCallback(() => {
    toast({ title: "Screen Share Ended", description: "Screen sharing was stopped from browser UI or window closed.", variant: "default" });
    if (status === "recording") {
      handleStopRecording();
    }
  }, [status, handleStopRecording, toast]);


  const startRecordingSharedLogic = useCallback(async (forReplay: boolean, timesliceOverride?: number) => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      setErrorMessage("Screen recording is not supported by your browser.");
      setStatus("error");
      toast({ title: "Error", description: "Screen recording not supported.", variant: "destructive" });
      return false;
    }

    // Reset relevant state for a new recording/buffering session
    setErrorMessage(null);
    if (recordedVideoUrl && !forReplay) URL.revokeObjectURL(recordedVideoUrl);
    if (!forReplay) setRecordedVideoUrl(null);
    
    recordedChunksRef.current = []; // Clear chunks for new session
    if(!forReplay) setNumRecordedChunks(0);


    let displayStream: MediaStream;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: includeSystemAudio,
      });
    } catch (err) {
      const typedError = err as Error;
      if (typedError.name === "NotAllowedError") {
        setErrorMessage("Permission to record screen was denied. Please allow access and try again.");
        toast({ title: "Permission Denied", description: "Screen recording permission was denied.", variant: "destructive" });
         console.info("Screen recording permission denied by user.");
      } else {
        setErrorMessage(`An error occurred while getting display media: ${typedError.message}`);
        toast({ title: "Screen Access Error", description: typedError.message, variant: "destructive" });
        console.error("Error getting display media:", typedError);
      }
      setStatus("error");
      cleanupStream();
      return false;
    }

    let finalStream = displayStream;
    if (includeMicAudio) {
      try {
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        micStream.getAudioTracks().forEach(track => {
          const clonedTrack = track.clone();
          finalStream.addTrack(clonedTrack);
           // Re-attach onended to the new track if it's a video track from mic (though unlikely)
          if (clonedTrack.kind === 'video') {
            clonedTrack.onended = handleStreamStopFromBrowser;
          }
        });
      } catch (micError) {
        const typedMicError = micError as Error;
        if (typedMicError.name === "NotAllowedError") {
          console.info("Microphone permission denied by user.");
          toast({ title: "Microphone Denied", description: "Mic access denied. Recording without mic.", variant: "default" });
        } else {
          console.warn("Error accessing microphone:", micError);
          toast({ title: "Microphone Error", description: "Could not access microphone. Recording without mic audio.", variant: "destructive" });
        }
      }
    }

    streamRef.current = finalStream;
    finalStream.getVideoTracks().forEach(track => track.onended = handleStreamStopFromBrowser);
    finalStream.getAudioTracks().forEach(track => track.onended = handleStreamStopFromBrowser); // Also for audio tracks if they end


    const optionsVp9 = { mimeType: 'video/webm; codecs=vp9' };
    const optionsDefault = { mimeType: 'video/webm' }; // Fallback

    try {
      if (MediaRecorder.isTypeSupported(optionsVp9.mimeType) && !forReplay) {
        mediaRecorderRef.current = new MediaRecorder(finalStream, optionsVp9);
        chosenMimeTypeRef.current = optionsVp9.mimeType;
      } else if (MediaRecorder.isTypeSupported(optionsDefault.mimeType)) {
        mediaRecorderRef.current = new MediaRecorder(finalStream, optionsDefault);
        chosenMimeTypeRef.current = optionsDefault.mimeType;
      } else {
         mediaRecorderRef.current = new MediaRecorder(finalStream); // Absolute fallback
         chosenMimeTypeRef.current = 'video/webm'; // Assume default
      }
    } catch (e) {
      console.warn("Error initializing MediaRecorder, falling back to basic init:", e);
      try {
        mediaRecorderRef.current = new MediaRecorder(finalStream);
        chosenMimeTypeRef.current = 'video/webm';
      } catch (finalError) {
        console.error("Fatal error initializing MediaRecorder even with fallback:", finalError);
        setErrorMessage("Failed to initialize recorder. Your browser might not support MediaRecorder with the selected inputs.");
        setStatus("error");
        cleanupStream();
        return false;
      }
    }
    
    mediaRecorderRef.current.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunksRef.current.push(event.data);
        if (!forReplay) { // Only update chunk count for main recording UI
          setNumRecordedChunks(prev => prev + 1);
        }
      }
    };

    mediaRecorderRef.current.onstop = () => {
      console.log("MediaRecorder.onstop triggered. Status:", status);
      if (!forReplay) {
        if (recordedChunksRef.current.length > 0) {
          const blob = new Blob(recordedChunksRef.current, { type: chosenMimeTypeRef.current });
          const url = URL.createObjectURL(blob);
          setRecordedVideoUrl(url);
          setStatus("stopped_pending_full_download");
          toast({ title: "Recording Finished", description: "Your video is ready.", icon: <CheckCircle2 className="h-5 w-5 text-green-500" /> });
        } else {
          setErrorMessage("No video data was recorded.");
          setStatus("error");
          toast({ title: "Recording Empty", description: "No video data was captured.", variant: "destructive" });
        }
      }
      // General cleanup for tracks after recorder stops, regardless of forReplay
      cleanupStream(); 
      // Note: recordedChunksRef is intentionally NOT cleared here for main recording, 
      // as it's needed for download/trim. It IS cleared in cleanupFullRecordingState or before new recording.
      // For replay, it's handled by its specific stop logic.
    };
    
    mediaRecorderRef.current.onerror = (event) => {
      console.error('MediaRecorder error:', event);
      setErrorMessage(`MediaRecorder error: ${(event as any)?.error?.name || 'Unknown error'}`);
      setStatus("error");
      toast({ title: "Recorder Error", description: "An error occurred with the media recorder.", variant: "destructive" });
      cleanupFullRecordingState();
    };


    try {
        const timeslice = timesliceOverride ?? (forReplay ? undefined : MAIN_RECORDING_CHUNK_DURATION_MS) ;
        if (timeslice) {
            mediaRecorderRef.current.start(timeslice);
        } else {
            mediaRecorderRef.current.start();
        }
        return true;
    } catch (e) {
        console.error("Error starting media recorder:", e);
        setErrorMessage("Failed to start recorder.");
        setStatus("error");
        cleanupStream();
        cleanupRecorder();
        return false;
    }

  }, [includeSystemAudio, includeMicAudio, recordedVideoUrl, toast, cleanupStream, cleanupRecorder, cleanupFullRecordingState, handleStreamStopFromBrowser, status, setNumRecordedChunks]);


  const handleStartRecording = async () => {
    setStatus("permission_pending");
    const success = await startRecordingSharedLogic(false, MAIN_RECORDING_CHUNK_DURATION_MS);
    if (success) {
      setStatus("recording");
      toast({ title: "Recording Started", icon: <Video className="h-5 w-5 text-red-500" /> });
    } else {
      // startRecordingSharedLogic already sets error status and toasts
      if(status !== "error"){ // if not already set to error by startRecordingSharedLogic
        setStatus("idle"); // fallback to idle if no specific error state was set
      }
    }
  };
  
  useEffect(() => {
    // General cleanup on unmount
    return () => {
      cleanupFullRecordingState();
    };
  }, [cleanupFullRecordingState]);

  const handleDownloadFullRecording = () => {
    if (recordedVideoUrl) {
      const a = document.createElement('a');
      a.href = recordedVideoUrl;
      a.download = `ScreenCatcher-Full-Recording-${new Date().toISOString()}.webm`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      toast({ title: "Download Started", description: "Your full recording is downloading." });
    }
  };

  const handleStartNewRecordingFromOptions = () => {
    cleanupFullRecordingState();
    setStatus("idle");
  };

  const handleSaveLiveClip = (clipDurationSeconds: number) => {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state !== "recording") {
      toast({ title: "Not Recording", description: "Cannot save clip, recording is not active.", variant: "destructive" });
      return;
    }

    const totalChunksAvailable = recordedChunksRef.current.length;
    const chunksNeededForClip = Math.ceil(clipDurationSeconds / (MAIN_RECORDING_CHUNK_DURATION_MS / 1000));

    if (totalChunksAvailable < chunksNeededForClip) {
      toast({ title: "Not Enough Footage", description: `Need at least ${clipDurationSeconds}s of recording to save this clip.`, variant: "destructive" });
      return;
    }

    const chunksForClip = recordedChunksRef.current.slice(-chunksNeededForClip);
    const blob = new Blob(chunksForClip, { type: chosenMimeTypeRef.current });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `ScreenCatcher-Clip-${clipDurationSeconds}s-${new Date().toISOString()}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url); // Clean up object URL after download link is clicked

    toast({ title: "Clip Saved!", description: `Last ${clipDurationSeconds}s clip is downloading.`, icon: <Save className="h-5 w-5 text-green-500" /> });
  };


  return (
    <Card className="w-full max-w-lg mx-auto shadow-2xl">
      <CardHeader>
        <CardTitle className="flex items-center text-3xl font-headline">
          <Clapperboard className="mr-3 h-8 w-8 text-primary" />
          ScreenCatcher
        </CardTitle>
        <CardDescription>
          Record your screen, window, or tab. Save clips live or download the full recording after stopping. Your browser will prompt you to select the source.
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

        {!showDownloadOptions && (
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
                disabled={isRecordingInProgress || isPermissionPending}
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
                disabled={isRecordingInProgress || isPermissionPending}
                aria-label="Toggle microphone audio"
              />
            </div>
          </div>
        )}

        <div className="flex flex-col items-center space-y-4">
          {!showDownloadOptions && (
            <>
              {isRecordingInProgress ? (
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
                  disabled={isPermissionPending}
                  aria-label="Start recording"
                >
                  <Video className="mr-2 h-5 w-5" />
                  {isPermissionPending ? "Waiting for Permission..." : "Start Recording"}
                </Button>
              )}
            </>
          )}
          
          <div className="text-sm text-muted-foreground h-5">
            {status === "recording" && "Recording..."}
            {status === "stopped_pending_full_download" && "Recording finished! Choose download option."}
            {status === "permission_pending" && "Awaiting screen share permission..."}
            {status === "idle" && "Ready to record."}
            {status === "error" && "An error occurred. Please refresh or try again."}
          </div>
        </div>

        {isRecordingInProgress && (
          <div className="space-y-4 p-4 border rounded-md bg-card-foreground/5 animate-fadeIn">
            <h3 className="text-lg font-medium text-foreground">Save Live Clip</h3>
            <div className="grid grid-cols-2 gap-2">
              {LIVE_CLIP_DURATIONS.map(clip => {
                const chunksNeeded = Math.ceil(clip.value / (MAIN_RECORDING_CHUNK_DURATION_MS / 1000));
                return (
                  <Button
                    key={clip.value}
                    variant="outline"
                    onClick={() => handleSaveLiveClip(clip.value)}
                    disabled={numRecordedChunks < chunksNeeded}
                    className="transition-all"
                    aria-label={`Save last ${clip.label.toLowerCase()}`}
                  >
                    <Save className="mr-2 h-4 w-4" /> {clip.label}
                  </Button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Saving a clip will not stop the main recording. {numRecordedChunks * (MAIN_RECORDING_CHUNK_DURATION_MS/1000)}s recorded.
            </p>
          </div>
        )}

        {showDownloadOptions && recordedVideoUrl && (
          <div className="space-y-4 p-4 border rounded-md bg-card-foreground/5 animate-fadeIn">
            <h3 className="text-lg font-medium text-foreground">Recording Complete</h3>
            <video src={recordedVideoUrl} controls className="w-full rounded-md shadow-md" />
            <Button
              onClick={handleDownloadFullRecording}
              className="w-full bg-accent hover:bg-accent/90 text-accent-foreground transition-all"
              aria-label="Download full recording"
            >
              <Download className="mr-2 h-5 w-5" />
              Download Full Recording (.webm)
            </Button>
             <Button
              onClick={handleStartNewRecordingFromOptions}
              variant="outline"
              className="w-full"
              aria-label="Record again"
            >
              <Video className="mr-2 h-5 w-5" />
              Record Again
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

