export interface SessionImage {
  id: string;
  record: number;
  index: number;
  text: string;
  alt: string;
  timestamp?: string;
  dataUrl?: string;
}

export type SessionImageInfo = Omit<SessionImage, 'dataUrl'>;
export interface SessionImageList { images: SessionImageInfo[]; total: number; offset: number; limit: number }
