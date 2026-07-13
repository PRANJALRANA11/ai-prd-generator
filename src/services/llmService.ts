import { GoogleGenAI } from "@google/genai";
import { logger } from "../utils/logger.js";
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
