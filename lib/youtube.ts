// Page-side YouTube structures shared by the content script and the
// sampling harness. Declares window.ytInitialPlayerResponse so both can
// read the player response without type assertions.

export interface CaptionTrack {
  baseUrl: string;
  kind?: string;
  languageCode?: string;
}

export interface PlayerResponse {
  playabilityStatus?: {
    status?: string;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
    };
  };
  videoDetails?: {
    videoId?: string;
    title?: string;
    /** Canonical per-channel key (UC-id); absent on some embeds. */
    channelId?: string;
    /** Display name; the channel-memory fallback key when channelId is
     * missing (names are not unique, so the memory namespaces them). */
    author?: string;
    /** Real video duration in seconds (string in the player response). */
    lengthSeconds?: string;
  };
}

declare global {
  interface Window {
    ytInitialPlayerResponse?: PlayerResponse;
  }
}

/** Stable per-channel memory key from the player response: the channelId
 * when present, else the author name (namespaced — names are not unique). */
export function channelKeyOf(videoDetails: PlayerResponse['videoDetails']): string | undefined {
  const id = videoDetails?.channelId;
  if (id !== undefined && id !== '') return id;
  const author = videoDetails?.author;
  return author !== undefined && author !== '' ? `author:${author}` : undefined;
}
