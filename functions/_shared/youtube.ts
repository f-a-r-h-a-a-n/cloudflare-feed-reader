/**
 * Tiny, dependency-free YouTube helpers, split out so importers (the reader
 * Function, the poller) don't pull in the XML parser that the rest of the feed
 * module needs. Pure string work only.
 */

/** The channel-uploads Atom feed lives at this path; used to detect YT feeds. */
export const YOUTUBE_FEED_MARKER = 'youtube.com/feeds/videos.xml';

/** Extract the 11-char video id from any YouTube watch/shorts/embed/youtu.be URL. */
export function youtubeVideoId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(
    /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([\w-]{11})/i,
  );
  return m ? m[1] : null;
}
