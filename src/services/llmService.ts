import { GoogleGenAI } from "@google/genai";
import { logger } from "../utils/logger.js";
import type { LinearTicketSpec } from "./linearService.js";
import type { TranscriptSegment } from "./meetBot.js";

const PRD_SYSTEM_PROMPT = `You are an expert Product Manager. You will be given a raw transcript from a product meeting. 
Your task is to analyze the discussion and produce a comprehensive Product Requirements Document (PRD) in clean Markdown format.

The PRD MUST include the following sections (skip a section only if there is absolutely no relevant information in the transcript):

## Executive Summary
A brief 2-3 sentence overview of the product/feature discussed.

## Background & Context
What problem is being solved? Why now? Any relevant market or technical context mentioned.

## Objectives & Goals
Clear, measurable objectives discussed in the meeting.

## Scope
What is in scope and out of scope for this effort.

## Functional Requirements
Detailed feature requirements, organized as a numbered list. Each requirement should be clear and actionable.

## Non-Functional Requirements
Performance, security, scalability, accessibility, and other quality requirements mentioned.

## User Stories
User stories in the format: "As a [user type], I want [goal] so that [benefit]."

## Technical Considerations
Any technical constraints, architecture decisions, or implementation details discussed.

## Open Questions & Risks
Questions that were raised but not resolved, and potential risks identified.

## Success Metrics
How success will be measured (KPIs, metrics, targets).

## Timeline & Milestones
Any deadlines, phases, or milestones mentioned.

---

Guidelines:
- Be thorough but concise.
- If the transcript is unclear or ambiguous, note it in "Open Questions."
- Use professional product management language.
- Organize information logically even if the meeting discussion jumped between topics.
- Do NOT fabricate information that was not discussed in the meeting.
- If a section has no relevant information from the transcript, include it with a note: "Not discussed in this meeting."
`;

/**
 * Generates a PRD from meeting transcript segments using Google Gemini.
 */
export async function generatePRD(
  apiKey: string,
  transcript: TranscriptSegment[],
): Promise<string> {
  const ctx = "LLMService";

  if (transcript.length === 0) {
    throw new Error("Cannot generate PRD from an empty transcript.");
  }

  // Format the transcript for the LLM
  const formattedTranscript = transcript
    .map((seg) => `[${seg.timestamp}] ${seg.speaker}: ${seg.text}`)
    .join("\n");

  logger.info(ctx, "Sending transcript to Gemini", {
    segmentCount: transcript.length,
    charCount: formattedTranscript.length,
  });

  const genai = new GoogleGenAI({ apiKey });

  const response = await genai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `Here is the meeting transcript:\n\n${formattedTranscript}\n\nPlease generate a comprehensive PRD based on this discussion.`,
          },
        ],
      },
    ],
    config: {
      systemInstruction: PRD_SYSTEM_PROMPT,
      temperature: 0.3,    // Lower temp for more structured output
      maxOutputTokens: 8192,
    },
  });

  const prdText = response.text ?? "";

  if (!prdText) {
    throw new Error("Gemini returned an empty response.");
  }

  logger.info(ctx, "PRD generated successfully", {
    outputLength: prdText.length,
  });

  return prdText;
}

export async function answerPRDQuestion(
  apiKey: string,
  prdMarkdown: string,
  question: string,
  transcript: TranscriptSegment[] = [],
  roadmap?: string,
): Promise<string> {
  const ctx = "LLMService";
  const genai = new GoogleGenAI({ apiKey });
  const transcriptContext = transcript
    .slice(-80)
    .map((seg) => `[${seg.timestamp}] ${seg.speaker}: ${seg.text}`)
    .join("\n");

  logger.info(ctx, "Answering PRD question", {
    questionLength: question.length,
    prdLength: prdMarkdown.length,
  });

  const response = await genai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `Current PRD:\n\n${prdMarkdown}\n\nRoadmap context:\n${roadmap ?? "No roadmap has been captured yet."}\n\nRecent transcript context:\n${transcriptContext || "No transcript context available."}\n\nQuestion from Slack:\n${question}`,
          },
        ],
      },
    ],
    config: {
      systemInstruction:
        "You answer questions about a product PRD and roadmap. Be concise, accurate, and grounded only in the provided PRD, roadmap, and transcript context. If the answer is not present, say what is missing and suggest the next clarification needed.",
      temperature: 0.2,
      maxOutputTokens: 2048,
    },
  });

  const answer = response.text?.trim() ?? "";
  if (!answer) {
    throw new Error("Gemini returned an empty PRD question response.");
  }
  return answer;
}

export async function updatePRDWithRoadmap(
  apiKey: string,
  prdMarkdown: string,
  roadmapNotes: string,
): Promise<string> {
  const ctx = "LLMService";
  const genai = new GoogleGenAI({ apiKey });

  logger.info(ctx, "Updating PRD with roadmap notes", {
    roadmapLength: roadmapNotes.length,
    prdLength: prdMarkdown.length,
  });

  const response = await genai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `Current PRD:\n\n${prdMarkdown}\n\nRoadmap updates or direction from Slack:\n\n${roadmapNotes}\n\nReturn the complete updated PRD in Markdown.`,
          },
        ],
      },
    ],
    config: {
      systemInstruction:
        "You update an existing PRD using new roadmap information. Preserve useful existing content, incorporate the roadmap as authoritative new direction, update goals/scope/requirements/timeline/risks where relevant, and do not invent unsupported details. Return only the complete updated PRD in clean Markdown.",
      temperature: 0.25,
      maxOutputTokens: 8192,
    },
  });

  const updatedPrd = response.text?.trim() ?? "";
  if (!updatedPrd) {
    throw new Error("Gemini returned an empty updated PRD.");
  }
  return updatedPrd;
}

export async function comparePRDVersions(
  apiKey: string,
  olderPrd: string,
  newerPrd: string,
  olderLabel: string,
  newerLabel: string,
): Promise<string> {
  const ctx = "LLMService";
  const genai = new GoogleGenAI({ apiKey });

  logger.info(ctx, "Comparing PRD versions", {
    olderLabel,
    newerLabel,
    olderLength: olderPrd.length,
    newerLength: newerPrd.length,
  });

  const response = await genai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `Older PRD (${olderLabel}):\n\n${olderPrd}\n\nNewer PRD (${newerLabel}):\n\n${newerPrd}`,
          },
        ],
      },
    ],
    config: {
      systemInstruction:
        "Compare two PRD versions. Return a concise Slack-friendly Markdown summary with: 1) major product changes, 2) scope changes, 3) roadmap/timeline changes, 4) risks or open questions introduced or resolved. Do not include unchanged sections.",
      temperature: 0.2,
      maxOutputTokens: 2048,
    },
  });

  const comparison = response.text?.trim() ?? "";
  if (!comparison) {
    throw new Error("Gemini returned an empty PRD version comparison.");
  }
  return comparison;
}

export async function generateLinearTicketSpecs(
  apiKey: string,
  prdMarkdown: string,
): Promise<LinearTicketSpec[]> {
  const ctx = "LLMService";
  const genai = new GoogleGenAI({ apiKey });

  logger.info(ctx, "Generating Linear ticket specs from PRD", {
    prdLength: prdMarkdown.length,
  });

  const response = await genai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `PRD:\n\n${prdMarkdown}\n\nCreate implementation-ready Linear tickets from this PRD.`,
          },
        ],
      },
    ],
    config: {
      systemInstruction:
        "You convert a PRD into a concise backlog for a coding agent. Return only valid JSON: an array of 3 to 8 objects with string fields title and description. Each description must include context, implementation notes, acceptance criteria, and any open questions. Do not include Markdown fences or commentary.",
      temperature: 0.2,
      maxOutputTokens: 4096,
    },
  });

  const rawText = response.text?.trim() ?? "";
  if (!rawText) {
    throw new Error("Gemini returned an empty Linear ticket response.");
  }

  const tickets = parseLinearTicketSpecs(rawText);
  if (tickets.length === 0) {
    throw new Error("Gemini did not return any Linear tickets.");
  }

  logger.info(ctx, "Linear ticket specs generated", { ticketCount: tickets.length });
  return tickets.slice(0, 8);
}

function parseLinearTicketSpecs(rawText: string): LinearTicketSpec[] {
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      throw new Error("Could not parse Linear ticket JSON from Gemini response.");
    }
    parsed = JSON.parse(arrayMatch[0]);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Linear ticket JSON must be an array.");
  }

  return parsed
    .map((item) => {
      if (!isRecord(item)) return null;
      const title = typeof item.title === "string" ? item.title.trim() : "";
      const description = typeof item.description === "string" ? item.description.trim() : "";
      if (!title || !description) return null;
      return { title, description };
    })
    .filter((item): item is LinearTicketSpec => item !== null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
