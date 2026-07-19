import { logger } from "../utils/logger.js";
import type { LinearTicketSpec } from "./linearService.js";
import type { TranscriptSegment } from "./meetBot.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

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
 * Generates a PRD from meeting transcript segments using OpenAI.
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

  logger.info(ctx, "Sending transcript to OpenAI", {
    segmentCount: transcript.length,
    charCount: formattedTranscript.length,
  });

  const prdText = await generateOpenAIText(apiKey, {
    system: PRD_SYSTEM_PROMPT,
    input: `Here is the meeting transcript:\n\n${formattedTranscript}\n\nPlease generate a comprehensive PRD based on this discussion.`,
    temperature: 0.3,
    maxOutputTokens: 8192,
  });

  if (!prdText) {
    throw new Error("OpenAI returned an empty response.");
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
  const transcriptContext = transcript
    .slice(-80)
    .map((seg) => `[${seg.timestamp}] ${seg.speaker}: ${seg.text}`)
    .join("\n");

  logger.info(ctx, "Answering PRD question", {
    questionLength: question.length,
    prdLength: prdMarkdown.length,
  });

  const answer = await generateOpenAIText(apiKey, {
    system:
      "You answer questions about a product PRD and roadmap. Be concise, accurate, and grounded only in the provided PRD, roadmap, and transcript context. If the answer is not present, say what is missing and suggest the next clarification needed.",
    input: `Current PRD:\n\n${prdMarkdown}\n\nRoadmap context:\n${roadmap ?? "No roadmap has been captured yet."}\n\nRecent transcript context:\n${transcriptContext || "No transcript context available."}\n\nQuestion from Slack:\n${question}`,
    temperature: 0.2,
    maxOutputTokens: 2048,
  });

  if (!answer.trim()) {
    throw new Error("OpenAI returned an empty PRD question response.");
  }
  return answer.trim();
}

export async function updatePRDWithRoadmap(
  apiKey: string,
  prdMarkdown: string,
  roadmapNotes: string,
): Promise<string> {
  const ctx = "LLMService";

  logger.info(ctx, "Updating PRD with roadmap notes", {
    roadmapLength: roadmapNotes.length,
    prdLength: prdMarkdown.length,
  });

  const updatedPrd = await generateOpenAIText(apiKey, {
    system:
      "You update an existing PRD using new roadmap information. Preserve useful existing content, incorporate the roadmap as authoritative new direction, update goals/scope/requirements/timeline/risks where relevant, and do not invent unsupported details. Return only the complete updated PRD in clean Markdown.",
    input: `Current PRD:\n\n${prdMarkdown}\n\nRoadmap updates or direction from Slack:\n\n${roadmapNotes}\n\nReturn the complete updated PRD in Markdown.`,
    temperature: 0.25,
    maxOutputTokens: 8192,
  });

  if (!updatedPrd.trim()) {
    throw new Error("OpenAI returned an empty updated PRD.");
  }
  return updatedPrd.trim();
}

export async function comparePRDVersions(
  apiKey: string,
  olderPrd: string,
  newerPrd: string,
  olderLabel: string,
  newerLabel: string,
): Promise<string> {
  const ctx = "LLMService";

  logger.info(ctx, "Comparing PRD versions", {
    olderLabel,
    newerLabel,
    olderLength: olderPrd.length,
    newerLength: newerPrd.length,
  });

  const comparison = await generateOpenAIText(apiKey, {
    system:
      "Compare two PRD versions. Return a concise Slack-friendly Markdown summary with: 1) major product changes, 2) scope changes, 3) roadmap/timeline changes, 4) risks or open questions introduced or resolved. Do not include unchanged sections.",
    input: `Older PRD (${olderLabel}):\n\n${olderPrd}\n\nNewer PRD (${newerLabel}):\n\n${newerPrd}`,
    temperature: 0.2,
    maxOutputTokens: 2048,
  });

  if (!comparison.trim()) {
    throw new Error("OpenAI returned an empty PRD version comparison.");
  }
  return comparison.trim();
}

export async function generateLinearTicketSpecs(
  apiKey: string,
  prdMarkdown: string,
): Promise<LinearTicketSpec[]> {
  const ctx = "LLMService";

  logger.info(ctx, "Generating Linear ticket spec from PRD", {
    prdLength: prdMarkdown.length,
  });

  const rawText = await generateOpenAIText(apiKey, {
    system:
      "You convert an approved PRD into one concise Linear ticket for a coding agent. Return only valid JSON: an array with exactly one object containing string fields title and description. Each description must include context, implementation notes, acceptance criteria, and any open questions. Do not include Markdown fences or commentary.",
    input: `PRD:\n\n${prdMarkdown}\n\nCreate exactly one implementation-ready Linear ticket from this PRD. The ticket should represent the full approved PRD scope and include enough detail for a coding agent to start work.`,
    temperature: 0.2,
    maxOutputTokens: 4096,
  });

  if (!rawText.trim()) {
    throw new Error("OpenAI returned an empty Linear ticket response.");
  }

  const tickets = parseLinearTicketSpecs(rawText);
  if (tickets.length === 0) {
    throw new Error("OpenAI did not return a Linear ticket.");
  }

  logger.info(ctx, "Linear ticket spec generated", { ticketCount: tickets.length });
  return tickets.slice(0, 1);
}

async function generateOpenAIText(
  apiKey: string,
  options: {
    system: string;
    input: string;
    temperature: number;
    maxOutputTokens: number;
  },
): Promise<string> {
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL,
      instructions: options.system,
      input: options.input,
      temperature: options.temperature,
      max_output_tokens: options.maxOutputTokens,
      store: false,
    }),
  });

  const body = await response.json().catch(() => undefined) as OpenAIResponseBody | undefined;
  if (!response.ok) {
    const message = body?.error?.message ?? response.statusText;
    throw new Error(`OpenAI response failed (${response.status}): ${message}`);
  }

  return extractOpenAIText(body).trim();
}

interface OpenAIResponseBody {
  output_text?: unknown;
  output?: unknown;
  error?: {
    message?: string;
  };
}

function extractOpenAIText(body: OpenAIResponseBody | undefined): string {
  if (!body) return "";
  if (typeof body.output_text === "string") return body.output_text;
  if (!Array.isArray(body.output)) return "";

  return body.output
    .flatMap((item) => {
      if (!isRecord(item) || !Array.isArray(item.content)) return [];
      return item.content
        .map((part) => {
          if (!isRecord(part)) return "";
          if (typeof part.text === "string") return part.text;
          if (typeof part.output_text === "string") return part.output_text;
          return "";
        })
        .filter(Boolean);
    })
    .join("\n");
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
      throw new Error("Could not parse Linear ticket JSON from OpenAI response.");
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
