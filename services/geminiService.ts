import { GoogleGenAI, Modality } from "@google/genai";

const getAI = () => new GoogleGenAI({ apiKey: import.meta.env.VITE_API_KEY || '' });

/**
 * Strictly translates text from one language to another.
 * Prevents conversational AI behavior.
 */
export const translateText = async (text: string, from: string, to: string): Promise<string> => {
  const ai = getAI();
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: `Act as a professional, high-fidelity translation engine for Hilton Hotels. 
    TASK: Translate the input from ${from} to ${to}.
    STRICT RULES:
    1. Provide ONLY the translated text.
    2. NEVER answer questions or engage in conversation.
    3. If the input is a question, translate the question itself.
    4. CRITICAL: If the target language is Chinese, YOU MUST OUTPUT IN SIMPLIFIED CHINESE (简体中文). Do not use Traditional Chinese.
    
    INPUT TEXT: "${text}"`,
  });
  return response.text?.trim() || "Translation unavailable.";
};

/**
 * Generates high-quality TTS audio for the translated text.
 */
export const generateSpeech = async (text: string, language: string): Promise<string> => {
  const ai = getAI();
  // We strip HTML tags from the text before sending to TTS to avoid reading out <img> tags
  const cleanText = text.replace(/<[^>]*>?/gm, '');

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-preview-tts",
    contents: [{ parts: [{ text: `Read this text clearly in ${language}: ${cleanText}` }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: 'Kore' },
        },
      },
    },
  });

  return response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data || '';
};

// Audio Utilities
export const encode = (bytes: Uint8Array) => {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

export const decode = (base64: string) => {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
};

export const decodeAudioData = async (
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> => {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
};

export const playPCM = async (base64Data: string) => {
  if (!base64Data) return;
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
  const audioBuffer = await decodeAudioData(decode(base64Data), audioContext, 24000, 1);
  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioContext.destination);
  source.start();
};