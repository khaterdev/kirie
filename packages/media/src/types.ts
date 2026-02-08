export type MediaKind = "image" | "audio" | "video" | "document" | "unknown";

export interface MediaAttachment {
  id: string;
  kind: MediaKind;
  mimeType: string;
  url?: string;
  localPath?: string;
  filename?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  isVoice?: boolean;
  transcript?: string;
}
