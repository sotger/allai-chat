/**
 * Media files that a browser plays instead of showing as a page. A link to one
 * of these is meant to be *saved*, not opened — but Chromium ignores the HTML
 * `download` attribute for cross-origin URLs and simply navigates to the file,
 * which turns the tab into a media player with no way to save anything. Safari
 * hands the same click to its download manager.
 *
 * AI services hit this all the time: the finished video lives on a CDN host
 * (`cdn.example.com/....mp4`), so the download button navigated the tab away
 * from the service instead of downloading the file. The main process therefore
 * turns a navigation to one of these URLs into a real download.
 */
const MEDIA_EXTENSIONS = new Set([
  // video
  'mp4', 'm4v', 'webm', 'mov', 'mpeg', 'mpg', 'ogv', '3gp', 'mkv', 'wmv', 'flv',
  // audio
  'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'weba'
]);

/** True for an http(s) URL whose path names a media file (query is ignored). */
export function isDownloadableMediaUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const name = url.pathname.split('/').pop() ?? '';
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return false;
    return MEDIA_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
  } catch {
    return false;
  }
}
