
export enum TranslationMode {
  SOLO = 'Solo',
  CONVERSATION = 'Conversation',
  IMAGE_EDIT = 'Image Edit'
}

export interface Language {
  code: string;
  name: string;
  flag?: string;
}

export interface HistoryItem {
  id: string;
  original: string;
  translated: string;
  timestamp: number;
}
