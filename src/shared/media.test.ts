import { describe, expect, it } from 'vitest';

import { isDownloadableMediaUrl } from './media';

describe('isDownloadableMediaUrl', () => {
  it('recognises video and audio files', () => {
    expect(isDownloadableMediaUrl('https://cdn.seedance.ai/Seeddance-AI-video.mp4')).toBe(true);
    expect(isDownloadableMediaUrl('https://cdn.example.com/a/b/clip.MOV')).toBe(true);
    expect(isDownloadableMediaUrl('https://cdn.example.com/track.m4a')).toBe(true);
    expect(isDownloadableMediaUrl('https://cdn.example.com/song.flac')).toBe(true);
  });

  it('ignores query strings and fragments', () => {
    expect(isDownloadableMediaUrl('https://cdn.example.com/v/clip.mp4?download=true&x=1')).toBe(true);
    expect(isDownloadableMediaUrl('https://cdn.example.com/v/clip.webm#t=2')).toBe(true);
  });

  it('leaves pages, APIs and documents alone', () => {
    expect(isDownloadableMediaUrl('https://www.seedance.ai/history')).toBe(false);
    expect(isDownloadableMediaUrl('https://chatgpt.com/c/abc')).toBe(false);
    expect(isDownloadableMediaUrl('https://example.com/api/video/user')).toBe(false);
    expect(isDownloadableMediaUrl('https://example.com/report.pdf')).toBe(false);
    expect(isDownloadableMediaUrl('https://example.com/manual.html')).toBe(false);
    expect(isDownloadableMediaUrl('https://example.com/watch?file=clip.mp4')).toBe(false);
  });

  it('rejects non-http URLs', () => {
    expect(isDownloadableMediaUrl('blob:https://example.com/1234')).toBe(false);
    expect(isDownloadableMediaUrl('data:video/mp4;base64,AAAA')).toBe(false);
    expect(isDownloadableMediaUrl('file:///tmp/clip.mp4')).toBe(false);
    expect(isDownloadableMediaUrl('not a url')).toBe(false);
  });

  it('needs a real file name', () => {
    expect(isDownloadableMediaUrl('https://example.com/video.mp4/')).toBe(false);
    expect(isDownloadableMediaUrl('https://example.com/.mp4')).toBe(false);
    expect(isDownloadableMediaUrl('https://example.com/')).toBe(false);
  });
});
