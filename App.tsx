import React, { useState, useRef, useEffect } from 'react';
import { TranslationMode, Language } from './types';
import { LANGUAGES } from './constants';
import { GoogleGenAI, Modality } from "@google/genai";
import { translateText, generateSpeech, playPCM, encode } from './services/geminiService';
import * as OpenCC from 'opencc-js';

// Initialize converter: Traditional (hk/tw) -> Simplified (cn)
const converter = OpenCC.Converter({ from: 'hk', to: 'cn' });

const App: React.FC = () => {
  const [mode, setMode] = useState<TranslationMode>(TranslationMode.SOLO);
  const [inputLang, setInputLang] = useState<Language>(LANGUAGES[0]);
  const [outputLang, setOutputLang] = useState<Language>(LANGUAGES[1]);

  // Shared "current view" content (bound to UI)
  const [transcript, setTranscript] = useState<string>("");
  const [translation, setTranslation] = useState<string>("");

  // Per-mode stored content so Solo / Bridge are isolated
  const [soloTranscript, setSoloTranscript] = useState<string>("");
  const [soloTranslation, setSoloTranslation] = useState<string>("");
  const [bridgeTranscript, setBridgeTranscript] = useState<string>("");
  const [bridgeTranslation, setBridgeTranslation] = useState<string>("");
  const [activeSpeaker, setActiveSpeaker] = useState<'host' | 'guest' | null>(null);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Selection UI state
  const [showInputPicker, setShowInputPicker] = useState(false);
  const [showOutputPicker, setShowOutputPicker] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  // Use a ref to track transcript for immediate access in closures/callbacks
  const transcriptRef = useRef<string>("");

  // Auto-scroll textarea as text arrives
  useEffect(() => {
    if (textareaRef.current && activeSpeaker && document.activeElement !== textareaRef.current) {
      textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
    }
  }, [transcript, activeSpeaker]);

  const handleSwap = () => {
    const temp = inputLang;
    setInputLang(outputLang);
    setOutputLang(temp);
    setTranscript("");
    transcriptRef.current = "";
    setTranslation("");
  };

  const handleModeChange = (newMode: TranslationMode) => {
    if (newMode === mode) return;

    // Save current view content into the mode we're leaving
    if (mode === TranslationMode.SOLO) {
      setSoloTranscript(transcriptRef.current);
      setSoloTranslation(translation);
    } else if (mode === TranslationMode.CONVERSATION) {
      setBridgeTranscript(transcriptRef.current);
      setBridgeTranslation(translation);
    }

    // Switch mode
    setMode(newMode);

    // Restore content for the mode we're entering (keeps modes separated)
    if (newMode === TranslationMode.SOLO) {
      setTranscript(soloTranscript);
      transcriptRef.current = soloTranscript;
      setTranslation(soloTranslation);
    } else if (newMode === TranslationMode.CONVERSATION) {
      setTranscript(bridgeTranscript);
      transcriptRef.current = bridgeTranscript;
      setTranslation(bridgeTranslation);
    }
  };

  const handlePlayAudio = async (text: string, lang: string) => {
    if (!text || isPlaying) return;
    setIsPlaying(true);
    try {
      const audio = await generateSpeech(text, lang);
      await playPCM(audio);
    } catch (e) {
      console.error("Audio playback failed", e);
    } finally {
      setIsPlaying(false);
    }
  };

  const startRecording = async (speaker: 'host' | 'guest') => {
    // Reset based on who is starting. 
    // If Host starts: Clear everything as usual.
    // If Guest starts: Clear everything to prepare for their turn.
    setTranscript("");
    transcriptRef.current = "";
    setTranslation("");
    setErrorMessage(null);
    setActiveSpeaker(speaker);

    try {
      const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_API_KEY || '' });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioContextRef.current = audioContext;

      // Determine languages based on speaker
      // Host: Speaking InputLang -> Transcribe in InputLang
      // Guest: Speaking OutputLang -> Transcribe in OutputLang
      const recordLang = speaker === 'host' ? inputLang : outputLang;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            const source = audioContext.createMediaStreamSource(stream);
            const processor = audioContext.createScriptProcessor(4096, 1, 1);
            processorRef.current = processor;

            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const l = inputData.length;
              const int16 = new Int16Array(l);
              for (let i = 0; i < l; i++) {
                int16[i] = Math.max(-1, Math.min(1, inputData[i])) * 32767;
              }
              const pcmBlob = {
                data: encode(new Uint8Array(int16.buffer)),
                mimeType: 'audio/pcm;rate=16000'
              };

              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              }).catch(err => console.error("Session send error:", err));
            };
            source.connect(processor);
            processor.connect(audioContext.destination);
          },
          onmessage: async (msg) => {
            if (msg.serverContent?.inputTranscription) {
              let newPart = msg.serverContent.inputTranscription.text || "";

              // FORCE CONVERSION: If recording language is Simplified Chinese (zh),
              // convert any Traditional characters to Simplified immediately.
              if (recordLang.code === 'zh') {
                newPart = converter(newPart);
              }

              transcriptRef.current += newPart;

              // Visual Feedback:
              // If Host speaking: Update 'transcript' (Bottom Card)
              // If Guest speaking: Update 'translation' (Top Card) as a live subtitle/preview
              if (speaker === 'host') {
                setTranscript(transcriptRef.current);
              } else {
                setTranslation(transcriptRef.current);
              }
            }
          },
          onerror: (e: any) => {
            console.error("Live API Error:", e);
            setErrorMessage("Recognition interrupted. Please check connection.");
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } },
          },
          systemInstruction: `You are a professional concierge transcriptionist.
          CONTEXT: A person is speaking in ${recordLang.name}.
          TASK: Provide a high-fidelity word-for-word transcription of their speech in ${recordLang.name}.
          STRICT RULES:
          1. Transcribe ONLY what you hear.
          2. Output ONLY the text in ${recordLang.name}.
          3. DO NOT translate to English or any other language unless the user is already speaking that language.
          4. DO NOT provide any conversational response.
          5. CRITICAL: If the target language is "Simplified Chinese" (zh), YOU MUST OUTPUT IN SIMPLIFIED CHINESE CHARACTERS (简体中文). NEVER use Traditional Chinese characters (繁体中文). Even if the speaker has a Taiwan or Cantonese accent, you MUST normalize the written output to Simplified Chinese. Do not mix scripts.`
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error("Recording error", err);
      setErrorMessage(`Could not start recording. (${err instanceof Error ? err.name + ': ' + err.message : String(err)})`);
      setActiveSpeaker(null);
    }
  };

  // Extracted translation logic to support both Voice stop and specific Text submit
  const handleTranslation = async (text: string, speaker: 'host' | 'guest') => {
    if (!text) {
      if (speaker === 'host') setTranslation("No voice input was detected.");
      if (speaker === 'guest') setTranscript("No voice input was detected.");
      return;
    }

    setIsProcessing(true);
    try {
      if (speaker === 'host') {
        const result = await translateText(text, inputLang.name, outputLang.name);
        setTranslation(result);
      } else if (speaker === 'guest') {
        // Guest spoke in OutputLang. We need to show this on their side.
        // We need to translate that to InputLang and put it in 'transcript' for the Host to see.
        const result = await translateText(text, outputLang.name, inputLang.name);
        setTranslation(text); // Ensure Top shows original Guest text
        setTranscript(result); // Bottom shows Translated English
      }
    } catch (e) {
      setErrorMessage("Processing failed. Please try again.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleTextSubmit = () => {
    if (!transcript.trim()) return;
    // When typing manually, we assume it's the Host typing in InputLang (Solo Mode) or Host side Bridge
    // If in Bridge Mode and Guest is active, they don't usually type? 
    // Let's assume manual input is primarily for Host in Solo/Bridge.
    handleTranslation(transcript.trim(), 'host');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleTextSubmit();
    }
  };

  const stopRecording = async () => {
    // Capture the current speaker before resetting
    const currentSpeaker = activeSpeaker;
    setActiveSpeaker(null);
    setIsProcessing(true); // interim loading while stopping

    if (processorRef.current) processorRef.current.disconnect();
    if (audioContextRef.current) audioContextRef.current.close();
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) { }
    }

    setTimeout(async () => {
      // Use the ref for latest text
      const textToTranslate = transcriptRef.current.trim();
      if (currentSpeaker) {
        await handleTranslation(textToTranslate, currentSpeaker);
      } else {
        setIsProcessing(false);
      }
    }, 100);
  };

  const LanguageModal = ({ active, onSelect, onClose }: { active: Language, onSelect: (l: Language) => void, onClose: () => void }) => (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 animate-in fade-in duration-300">
      <div className="absolute inset-0 bg-primary/40 backdrop-blur-md" onClick={onClose}></div>
      <div className="bg-white dark:bg-slate-900 w-full max-w-md rounded-[2.5rem] shadow-2xl relative z-10 overflow-hidden border border-slate-100 dark:border-slate-800">
        <div className="p-8 border-b border-slate-50 dark:border-slate-800 flex justify-between items-center bg-slate-50/50 dark:bg-slate-800/50">
          <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-primary dark:text-accent">Select Language</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-primary"><span className="material-icons-outlined">close</span></button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-4 grid grid-cols-1 gap-2">
          {LANGUAGES.map((l) => (
            <button
              key={l.code}
              onClick={() => { onSelect(l); onClose(); }}
              className={`flex items-center space-x-4 p-4 rounded-2xl transition-all ${active.code === l.code ? 'bg-primary text-white shadow-lg' : 'hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300'}`}
            >
              <img src={l.flag} alt={`${l.name} flag`} className="w-8 h-auto rounded-md shadow-sm object-cover" />
              <span className="font-bold flex-grow text-left">{l.name}</span>
              {active.code === l.code && <span className="material-icons-outlined text-sm">check_circle</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <div className="bg-background-light dark:bg-background-dark text-text-light dark:text-text-dark min-h-screen flex flex-col font-sans text-sm sm:text-lg transition-all selection:bg-primary/30">

      {showInputPicker && <LanguageModal active={inputLang} onSelect={setInputLang} onClose={() => setShowInputPicker(false)} />}
      {showOutputPicker && <LanguageModal active={outputLang} onSelect={setOutputLang} onClose={() => setShowOutputPicker(false)} />}

      {mode !== TranslationMode.CONVERSATION && (
        <header className="bg-primary p-4 pt-10 sm:p-6 sm:pt-14 text-center rounded-b-[2.5rem] sm:rounded-b-[3rem] shadow-2xl transition-all relative overflow-hidden flex-shrink-0">
          <div className="absolute top-0 left-0 w-full h-full opacity-10 pointer-events-none bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')]"></div>
          <div className="relative z-10">
            <div className="flex justify-center mb-4 sm:mb-6">
              <img src="/hilton-logo.png" alt="Hilton Logo" className="h-14 sm:h-20 w-auto transition-all" />
            </div>
            {/* Body text-sm (14px) -> Headline 3x = 42px. Desktop text-base (16px) -> Headline 3x = 48px (text-5xl) */}
            <h1 className="text-white font-display text-3xl leading-tight sm:text-5xl font-bold tracking-widest uppercase opacity-100 mt-2 sm:mt-4 break-words">AI Translator</h1>
          </div>
        </header>
      )}

      <main className={`flex-grow flex flex-col transition-all overflow-y-auto overflow-x-hidden ${mode === TranslationMode.CONVERSATION ? 'p-0' : 'px-4 -mt-4 sm:-mt-6 z-10'}`}>

        {mode !== TranslationMode.CONVERSATION && (
          <div className="bg-white dark:bg-slate-900 rounded-2xl p-1 shadow-xl border border-slate-100 dark:border-slate-800 mb-4 sm:mb-6 flex max-w-[240px] mx-auto w-full sticky top-2 z-20">
            <button onClick={() => handleModeChange(TranslationMode.SOLO)} className={`flex-1 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${mode === TranslationMode.SOLO ? 'bg-primary text-white shadow-md' : 'text-slate-400 hover:text-slate-600'}`}>Solo</button>
            <button onClick={() => handleModeChange(TranslationMode.CONVERSATION)} className="flex-1 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all text-slate-400 hover:text-slate-600">Bridge</button>
          </div>
        )}

        {mode === TranslationMode.SOLO && (
          <div className="max-w-md mx-auto w-full space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-500 pb-32">

            {errorMessage && (
              <div className="bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 p-3 rounded-xl text-xs font-bold text-center border border-red-100 dark:border-red-900/30 animate-pulse">
                <span>{errorMessage}</span>
              </div>
            )}

            {/* Translation Result Card */}
            {(translation || isProcessing) && (
              <div className="bg-primary rounded-[2rem] p-6 shadow-2xl animate-in slide-in-from-top-4 duration-500 relative overflow-hidden group">
                <div className="absolute -left-8 -bottom-8 w-32 h-32 bg-accent/10 rounded-full blur-3xl"></div>
                <div className="flex justify-between items-center mb-4 relative z-10">
                  <span className="text-white text-[10px] font-black uppercase tracking-[0.2em]">To: {outputLang.name}</span>
                  <button
                    disabled={isProcessing || isPlaying || !translation}
                    onClick={() => handlePlayAudio(translation, outputLang.name)}
                    className="w-10 h-10 rounded-full bg-white/10 text-white flex items-center justify-center hover:bg-white/20 transition-all active:scale-95 disabled:opacity-30 shadow-lg"
                  >
                    <span className={`material-icons-outlined text-lg ${isProcessing || isPlaying ? 'animate-spin' : ''}`}>
                      {isProcessing || isPlaying ? 'sync' : 'volume_up'}
                    </span>
                  </button>
                </div>
                <div className="relative z-10">
                  {isProcessing && !translation ? (
                    <div className="flex items-center space-x-2 text-white/50 italic py-4">
                      <div className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce"></div>
                      <div className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                      <div className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                      <span className="text-xs font-bold uppercase tracking-widest ml-2">Translating...</span>
                    </div>
                  ) : (
                    <div
                      className="text-white text-xl sm:text-2xl font-bold leading-relaxed break-words prose prose-invert max-w-none prose-img:rounded-xl prose-img:shadow-lg prose-img:border prose-img:border-white/10 prose-img:mt-2"
                      dangerouslySetInnerHTML={{ __html: translation }}
                    />
                  )}
                </div>
              </div>
            )}

            {/* Input & Controls Card */}
            <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] pt-6 px-6 pb-6 shadow-xl border border-slate-50 dark:border-slate-800 relative overflow-hidden flex flex-col">
              <div className="absolute top-0 right-0 w-24 h-24 bg-accent/5 rounded-full -mr-12 -mt-12 blur-2xl"></div>

              <div className="flex items-center justify-between mb-6 relative z-10">
                <button onClick={() => setShowInputPicker(true)} className="flex-1 text-center group">
                  <p className="text-[9px] uppercase font-bold tracking-[0.2em] text-slate-400 mb-1 group-hover:text-accent transition-colors">From</p>
                  <div className="flex flex-col items-center">
                    <span className="text-primary dark:text-accent font-black text-sm sm:text-base underline decoration-accent/30 underline-offset-4 group-hover:decoration-accent transition-all">{inputLang.name}</span>
                  </div>
                </button>
                <button onClick={handleSwap} className="w-10 h-10 rounded-full bg-slate-50 dark:bg-slate-800 text-accent flex items-center justify-center hover:rotate-180 transition-transform duration-500 shadow-inner mx-2">
                  <span className="material-icons-outlined text-xl">swap_horiz</span>
                </button>
                <button onClick={() => setShowOutputPicker(true)} className="flex-1 text-center group">
                  <p className="text-[9px] uppercase font-bold tracking-[0.2em] text-slate-400 mb-1 group-hover:text-accent transition-colors">To</p>
                  <div className="flex flex-col items-center">
                    <span className="text-primary dark:text-accent font-black text-sm sm:text-base underline decoration-accent/30 underline-offset-4 group-hover:decoration-accent transition-all">{outputLang.name}</span>
                  </div>
                </button>
              </div>

              <div className="relative z-0 group flex-grow">
                <textarea
                  ref={textareaRef}
                  value={transcript}
                  onChange={(e) => {
                    const val = e.target.value;
                    setTranscript(val);
                    transcriptRef.current = val;
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder={activeSpeaker ? `Listening...` : `Speak or type...`}
                  className="w-full h-80 sm:h-96 bg-slate-50/50 dark:bg-slate-800/30 rounded-3xl p-5 pb-28 border-2 border-dashed border-slate-100 dark:border-slate-800 transition-all text-slate-700 dark:text-slate-200 text-lg sm:text-xl font-medium leading-relaxed resize-none focus:border-accent focus:ring-0 focus:bg-white dark:focus:bg-slate-800 shadow-inner"
                />
                {!transcript && !activeSpeaker && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none opacity-20 pb-20">
                    <span className="material-icons-outlined text-4xl mb-2">keyboard_voice</span>
                    <p className="text-[9px] font-black uppercase tracking-widest text-center">Tap Mic</p>
                  </div>
                )}
                {activeSpeaker === 'host' && (
                  <div className="absolute top-3 right-4 flex items-center space-x-1.5 bg-red-500/10 text-red-500 px-2.5 py-1 rounded-full border border-red-500/20 shadow-sm backdrop-blur-sm">
                    <div className="w-1.5 h-1.5 bg-red-500 rounded-full animate-ping"></div>
                    <span className="text-[9px] font-black uppercase tracking-widest">Live</span>
                  </div>
                )}
                {/* Send Button for Manual Text Input */}
                {transcript && !activeSpeaker && (
                  <div className="absolute bottom-28 right-4 z-30">
                    <button
                      onClick={handleTextSubmit}
                      className="bg-primary hover:bg-primary-dark text-white rounded-full p-2 shadow-lg transition-transform active:scale-95"
                    >
                      <span className="material-icons-outlined text-xl">arrow_upward</span>
                    </button>
                  </div>
                )}
              </div>

              <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-50">
                <button
                  onClick={activeSpeaker ? stopRecording : () => startRecording('host')}
                  disabled={isProcessing || (activeSpeaker === 'guest')}
                  className={`w-20 h-20 rounded-full flex items-center justify-center transition-all active:scale-90 shadow-2xl ${activeSpeaker === 'host' ? 'bg-red-500 scale-105 shadow-red-500/40' : 'bg-primary hover:opacity-90 shadow-primary/40'} ${isProcessing ? 'cursor-wait' : (activeSpeaker === 'guest' ? 'opacity-50 grayscale cursor-not-allowed' : 'hover:scale-105')}`}
                >
                  <span className={`material-icons-outlined text-4xl text-white ${isProcessing ? 'animate-spin' : ''}`}>
                    {isProcessing ? 'sync' : (activeSpeaker === 'host' ? 'stop' : 'mic')}
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}

        {mode === TranslationMode.CONVERSATION && (
          <div className="flex flex-col h-screen overflow-hidden bg-slate-100 dark:bg-black p-4 gap-2 animate-in fade-in duration-700 relative">

            {/* Guest Card (Top, Rotated) */}
            <div className="flex-1 rotate-180 bg-white dark:bg-slate-900 rounded-[2.5rem] shadow-xl relative overflow-hidden flex flex-col items-center justify-center p-6 border border-slate-200 dark:border-slate-800">
              {/* Guest Language Label (Top-Left from Guest perspective) */}
              <div className="w-full flex justify-start pb-4 pointer-events-none">
                <span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">{outputLang.name}</span>
              </div>

              <div className="flex-grow w-full overflow-y-auto custom-scrollbar flex flex-col">
                <div
                  className="my-auto mx-auto font-black text-primary dark:text-white leading-tight text-left break-words max-w-[90%] transition-all duration-300 text-2xl sm:text-4xl"
                  dangerouslySetInnerHTML={{ __html: translation || (activeSpeaker === 'guest' ? "Listening..." : "Waiting...") }}
                />
              </div>

              {/* Guest Controls */}
              <div className="mt-6 flex-shrink-0 z-30">
                <button
                  onClick={activeSpeaker ? stopRecording : () => startRecording('guest')}
                  disabled={isProcessing || (activeSpeaker === 'host')}
                  className={`w-20 h-20 rounded-full flex items-center justify-center shadow-lg transition-all active:scale-95 ${activeSpeaker === 'guest' ? 'bg-red-500 scale-110 shadow-red-500/40' : 'bg-slate-100 dark:bg-slate-800 text-primary dark:text-white hover:bg-slate-200 dark:hover:bg-slate-700'} ${isProcessing ? 'cursor-wait' : (activeSpeaker === 'host' ? 'opacity-30 cursor-not-allowed' : '')}`}
                >
                  <span className={`material-icons-outlined text-4xl ${isProcessing ? 'animate-spin' : ''}`}>
                    {isProcessing ? 'sync' : (activeSpeaker === 'guest' ? 'stop' : 'mic')}
                  </span>
                </button>
              </div>

              {translation && (
                <button
                  onClick={() => handlePlayAudio(translation, outputLang.name)}
                  className="absolute bottom-6 left-6 p-3 bg-slate-50 dark:bg-slate-800 rounded-full text-primary dark:text-white shadow-sm z-20"
                >
                  <span className={`material-icons-outlined ${isPlaying ? 'animate-spin' : ''}`}>
                    {isPlaying ? 'sync' : 'volume_up'}
                  </span>
                </button>
              )}
            </div>

            {/* Center Controls Overlay */}
            <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 z-50 flex justify-center pointer-events-none">
              <button
                onClick={() => handleModeChange(TranslationMode.SOLO)}
                className="bg-primary text-white px-6 py-2 rounded-full shadow-xl transform hover:scale-105 transition-all pointer-events-auto flex items-center gap-2 border-2 border-slate-100 dark:border-slate-900"
              >
                <span className="material-icons-outlined text-lg">close</span>
                <span className="text-[10px] font-black uppercase tracking-widest">Back</span>
              </button>
            </div>

            {/* Host Card (Bottom) */}
            <div className="flex-1 bg-white dark:bg-slate-900 rounded-[2.5rem] shadow-xl relative overflow-hidden flex flex-col items-center justify-center p-6 border border-slate-200 dark:border-slate-800">
              {/* Host Language Label (Top-Left) */}
              <div className="w-full flex justify-start pb-4 pointer-events-none">
                <span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">{inputLang.name}</span>
              </div>

              <div className="flex-grow w-full overflow-y-auto custom-scrollbar flex flex-col">
                <div className="my-auto mx-auto font-black text-primary dark:text-white leading-tight text-left break-words max-w-[90%] transition-all duration-300 text-2xl sm:text-4xl">
                  {transcript || (activeSpeaker === 'host' ? "Listening..." : "Tap Mic to Speak")}
                </div>
              </div>

              {/* Host Controls */}
              <div className="mt-6 flex-shrink-0 z-30">
                <button
                  onClick={activeSpeaker ? stopRecording : () => startRecording('host')}
                  disabled={isProcessing || (activeSpeaker === 'guest')}
                  className={`w-24 h-24 rounded-full flex items-center justify-center shadow-2xl transition-all active:scale-90 ${activeSpeaker === 'host' ? 'bg-red-500 scale-110 shadow-red-500/40' : 'bg-primary hover:scale-105 shadow-primary/40'} ${isProcessing ? 'cursor-wait' : (activeSpeaker === 'guest' ? 'opacity-30 grayscale cursor-not-allowed' : '')}`}
                >
                  <span className={`material-icons-outlined text-5xl text-white ${isProcessing ? 'animate-spin' : ''}`}>
                    {isProcessing ? 'sync' : (activeSpeaker === 'host' ? 'stop' : 'mic')}
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;