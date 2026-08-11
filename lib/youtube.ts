// Page-side YouTube structures shared by the content script and the
// sampling harness. Declares window.ytInitialPlayerResponse so both can
// read the player response without type assertions.

interface CaptionTrack {
  baseUrl: string;
  kind?: string;
  languageCode?: string;
}

export interface PlayerResponse {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
    };
  };
  videoDetails?: {
    videoId?: string;
    title?: string;
  };
}

declare global {
  interface Window {
    ytInitialPlayerResponse?: PlayerResponse;
  }
}
