import fs from "fs/promises";
import { logger } from "../utils/logger.js";
import type { TranscriptSegment } from "./meetBot.js";

interface DeepgramWord {
  word?: string;
  punctuated_word?: string;
  start?: number;
  end?: number;
  speaker?: number;
}

interface DeepgramUtterance {
  start?: number;
  end?: number;
  transcript?: string;
  speaker?: number;
  words?: DeepgramWord[];
}

interface DeepgramAlternative {
  transcript?: string;
  words?: DeepgramWord[];
}

interface DeepgramResponse {
  results?: {
    utterances?: DeepgramUtterance[];
    channels?: Array<{
      alternatives?: DeepgramAlternative[];
    }>;
  };
  err_code?: string;
  err_msg?: string;
}

export async function transcribeAudioFile(
  apiKey: string,
  audioFilePath: string,
  contentType: string,
  recordingStartedAt: Date,
): Promise<TranscriptSegment[]> {
  const ctx = "DeepgramService";
  const audio = await fs.readFile(audioFilePath);

  logger.info(ctx, "Sending meeting audio to Deepgram", {
    audioFilePath,
    bytes: audio.byteLength,
    contentType,
  });

  return transcribeAudioBuffer(apiKey, audio, contentType, recordingStartedAt, audioFilePath);
}

export async function transcribeAudioBuffer(
  apiKey: string,
  audio: Buffer,
  contentType: string,
  recordingStartedAt: Date,
  label = "buffer",
): Promise<TranscriptSegment[]> {
  const ctx = "DeepgramService";

  logger.info(ctx, "Sending audio buffer to Deepgram", {
    label,
    bytes: audio.byteLength,
    contentType,
  });

  const params = new URLSearchParams({
    model: "nova-3",
    smart_format: "true",
    punctuate: "true",
    utterances: "true",
    diarize_model: "latest",
  });

  const audioBody = audio.buffer.slice(
    audio.byteOffset,
    audio.byteOffset + audio.byteLength,
  ) as ArrayBuffer;

  const response = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": contentType,
    },
    body: audioBody,
  });

  const body = (await response.json()) as DeepgramResponse;

  if (!response.ok) {
    throw new Error(
      `Deepgram transcription failed (${response.status}): ${body.err_msg ?? response.statusText}`,
    );
  }

  const transcript = parseDeepgramTranscript(body, recordingStartedAt);
  logger.info(ctx, "Deepgram transcription completed", {
    label,
    segments: transcript.length,
  });

  return transcript;
}

function parseDeepgramTranscript(
  response: DeepgramResponse,
  recordingStartedAt: Date,
): TranscriptSegment[] {
  const utterances = response.results?.utterances ?? [];
  if (utterances.length > 0) {
    return utterances
      .filter((utterance) => utterance.transcript?.trim())
      .map((utterance) => ({
        timestamp: offsetTimestamp(recordingStartedAt, utterance.start ?? 0),
        speaker: speakerLabel(utterance.speaker),
        text: utterance.transcript!.trim(),
      }));
  }

  const words = response.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
  if (words.length > 0) {
    return groupWordsBySpeaker(words, recordingStartedAt);
  }

  const transcript = response.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
  if (transcript) {
    return [
      {
        timestamp: recordingStartedAt.toISOString(),
        speaker: "Unknown",
        text: transcript,
      },
    ];
  }

  return [];
}

function groupWordsBySpeaker(words: DeepgramWord[], recordingStartedAt: Date): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let currentSpeaker: number | undefined;
  let currentWords: string[] = [];
  let currentStart = 0;

  for (const word of words) {
    const speaker = word.speaker;
    const text = word.punctuated_word ?? word.word;
    if (!text) continue;

    if (currentWords.length === 0) {
      currentSpeaker = speaker;
      currentStart = word.start ?? 0;
    }

    if (speaker !== currentSpeaker && currentWords.length > 0) {
      segments.push({
        timestamp: offsetTimestamp(recordingStartedAt, currentStart),
        speaker: speakerLabel(currentSpeaker),
        text: currentWords.join(" "),
      });
      currentWords = [];
      currentStart = word.start ?? 0;
      currentSpeaker = speaker;
    }

    currentWords.push(text);
  }

  if (currentWords.length > 0) {
    segments.push({
      timestamp: offsetTimestamp(recordingStartedAt, currentStart),
      speaker: speakerLabel(currentSpeaker),
      text: currentWords.join(" "),
    });
  }

  return segments;
}

function speakerLabel(speaker: number | undefined): string {
  return typeof speaker === "number" ? `Speaker ${speaker}` : "Unknown";
}

function offsetTimestamp(startedAt: Date, offsetSeconds: number): string {
  return new Date(startedAt.getTime() + offsetSeconds * 1000).toISOString();
}
