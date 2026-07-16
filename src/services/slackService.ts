import { logger } from "../utils/logger.js";

export interface SlackWebhookPayload {
  text: string;
  response_type?: "ephemeral" | "in_channel";
  blocks?: Array<Record<string, unknown>>;
}

interface PRDSection {
  title: string;
  body: string;
}

interface PRDMetadata {
  meetUrl?: string;
  meetingDuration?: string;
  participantCount?: number;
  sessionId?: string;
  version?: number;
  reason?: string;
}

/**
 * Posts a generated PRD to the configured Slack incoming webhook.
 *
 * The PRD is posted as rich Slack blocks. If it is too long for one webhook
 * payload, sections are split across multiple webhook messages.
 */
export async function postPRDToSlack(
  webhookUrl: string,
  prdMarkdown: string,
  metadata?: PRDMetadata,
): Promise<void> {
  const ctx = "SlackService";

  logger.info(ctx, "Posting PRD to Slack webhook", { prdLength: prdMarkdown.length });

  const messages = buildPRDMessages(prdMarkdown, metadata);

  for (let i = 0; i < messages.length; i++) {
    await postSlackWebhook(webhookUrl, messages[i]);
    if (i > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  logger.info(ctx, `Posted ${messages.length} PRD webhook message(s)`);
  logger.info(ctx, "PRD posted to Slack successfully");
}

export async function postSlackWebhook(
  webhookUrl: string,
  payload: SlackWebhookPayload,
): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Slack webhook failed (${response.status}): ${body || response.statusText}`);
  }
}

export function buildVersionHistoryText(
  versions: Array<{
    version: number;
    createdAt: Date;
    roadmapNotes?: string;
    changeSummary?: string;
  }>,
): string {
  if (versions.length === 0) {
    return "No PRD versions are available yet.";
  }

  return versions
    .map((version) => {
      const reason = version.changeSummary ?? version.roadmapNotes ?? "Initial generated PRD";
      return `*v${version.version}* · ${version.createdAt.toLocaleString()}\n${truncate(reason, 220)}`;
    })
    .join("\n\n");
}

function buildPRDMessages(prdMarkdown: string, metadata?: PRDMetadata): SlackWebhookPayload[] {
  const sections = parsePRDSections(prdMarkdown);
  const messages: SlackWebhookPayload[] = [];
  const introBlocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: metadata?.version
          ? `PRD v${metadata.version} Ready`
          : "PRD Ready",
        emoji: true,
      },
    },
    {
      type: "section",
      fields: buildMetadataFields(metadata),
    },
    { type: "divider" },
  ];

  const executiveSummary = sections.find((section) => /executive summary/i.test(section.title));
  if (executiveSummary) {
    introBlocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Executive Summary*\n${formatSlackMrkdwn(executiveSummary.body, 1400)}`,
      },
    });
  }

  if (metadata?.sessionId) {
    introBlocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "approve_linear_tickets",
          style: "primary",
          text: {
            type: "plain_text",
            text: "Approve Linear Tickets",
            emoji: true,
          },
          value: metadata.sessionId,
          confirm: {
            title: {
              type: "plain_text",
              text: "Create Linear tickets?",
            },
            text: {
              type: "mrkdwn",
              text: "This will turn the approved PRD into coding-agent-ready Linear tickets.",
            },
            confirm: {
              type: "plain_text",
              text: "Create tickets",
            },
            deny: {
              type: "plain_text",
              text: "Cancel",
            },
          },
        },
      ],
    });
  }

  introBlocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: buildCommandHint(metadata?.sessionId),
      },
    ],
  });

  messages.push({
    text: "PRD generated from meeting",
    blocks: introBlocks,
  });

  const contentSections = sections.filter((section) => section !== executiveSummary);
  let currentBlocks: Array<Record<string, unknown>> = [];

  for (const section of contentSections) {
    const sectionBlocks = buildSectionBlocks(section);
    if (currentBlocks.length + sectionBlocks.length > 45) {
      messages.push({
        text: "PRD continued",
        blocks: currentBlocks,
      });
      currentBlocks = [];
    }
    currentBlocks.push(...sectionBlocks);
  }

  if (currentBlocks.length > 0) {
    messages.push({
      text: "PRD continued",
      blocks: currentBlocks,
    });
  }

  return messages;
}

function buildMetadataFields(metadata?: PRDMetadata): Array<Record<string, string>> {
  const fields: Array<Record<string, string>> = [
    {
      type: "mrkdwn",
      text: `*Generated*\n${new Date().toLocaleString()}`,
    },
  ];

  if (metadata?.version) {
    fields.push({
      type: "mrkdwn",
      text: `*Version*\nv${metadata.version}`,
    });
  }
  if (metadata?.sessionId) {
    fields.push({
      type: "mrkdwn",
      text: `*Session*\n\`${metadata.sessionId}\``,
    });
  }
  if (metadata?.meetUrl) {
    fields.push({
      type: "mrkdwn",
      text: `*Meeting*\n<${metadata.meetUrl}|Google Meet>`,
    });
  }
  if (metadata?.meetingDuration) {
    fields.push({
      type: "mrkdwn",
      text: `*Duration*\n${metadata.meetingDuration}`,
    });
  }
  if (metadata?.participantCount) {
    fields.push({
      type: "mrkdwn",
      text: `*Participants*\n${metadata.participantCount}`,
    });
  }
  if (metadata?.reason) {
    fields.push({
      type: "mrkdwn",
      text: `*Update*\n${truncate(metadata.reason, 160)}`,
    });
  }

  return fields;
}

function parsePRDSections(markdown: string): PRDSection[] {
  const sections: PRDSection[] = [];
  let currentTitle = "Overview";
  let currentBody: string[] = [];

  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      if (currentBody.join("\n").trim()) {
        sections.push({
          title: currentTitle,
          body: currentBody.join("\n").trim(),
        });
      }
      currentTitle = heading[1].trim();
      currentBody = [];
    } else if (!/^#\s+/.test(line)) {
      currentBody.push(line);
    }
  }

  if (currentBody.join("\n").trim()) {
    sections.push({
      title: currentTitle,
      body: currentBody.join("\n").trim(),
    });
  }

  return sections.length > 0 ? sections : [{ title: "PRD", body: markdown }];
}

function buildSectionBlocks(section: PRDSection): Array<Record<string, unknown>> {
  const chunks = splitText(formatSlackMrkdwn(section.body), 2800);
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: truncate(section.title, 140),
        emoji: true,
      },
    },
    ...chunks.map((chunk) => ({
      type: "section",
      text: {
        type: "mrkdwn",
        text: chunk,
      },
    })),
    { type: "divider" },
  ];
}

function formatSlackMrkdwn(markdown: string, maxLen = 2800): string {
  const formatted = markdown
    .replace(/^###\s+(.+)$/gm, "*$1*")
    .replace(/^####\s+(.+)$/gm, "*$1*")
    .replace(/^\d+\.\s+/gm, "• ")
    .replace(/^- /gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return truncate(formatted || "Not discussed in this meeting.", maxLen);
}

function buildCommandHint(sessionId?: string): string {
  const target = sessionId ? ` \`${sessionId}\`` : "";
  return `Try: \`/prd${target} help\` · \`/prd${target} history\` · \`/prd${target} roadmap <update>\` · \`/prd${target} diff v1 v2\``;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let breakPoint = remaining.lastIndexOf("\n\n", maxLen);
    if (breakPoint <= 0) breakPoint = remaining.lastIndexOf("\n", maxLen);
    if (breakPoint <= 0) breakPoint = remaining.lastIndexOf(" ", maxLen);
    if (breakPoint <= 0) breakPoint = maxLen;

    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint).trimStart();
  }

  return chunks;
}
