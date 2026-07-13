import { WebClient, type KnownBlock } from "@slack/web-api";
import { logger } from "../utils/logger.js";

/**
 * Posts a generated PRD to the configured Slack channel.
 *
 * The PRD is posted as a rich message with a header and the PRD content
 * in a Slack `mrkdwn` section. If the PRD is too long for a single message,
 * it is split across multiple messages in a thread.
 */
export async function postPRDToSlack(
  botToken: string,
  channelId: string,
  prdMarkdown: string,
  metadata?: {
    meetUrl?: string;
    meetingDuration?: string;
    participantCount?: number;
  },
): Promise<void> {
  const ctx = "SlackService";
  const client = new WebClient(botToken);

  // Slack's max text block size is ~3000 chars for `mrkdwn` sections
  const SLACK_BLOCK_LIMIT = 2900;

  logger.info(ctx, "Posting PRD to Slack", { channelId, prdLength: prdMarkdown.length });

  // ── Build the header message ───────────────────────────
  const headerBlocks: KnownBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "📋 New PRD Generated from Meeting",
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: buildMetadataLine(metadata),
      },
    },
    { type: "divider" },
  ];

  // ── Split PRD into chunks if needed ────────────────────
  const prdChunks = splitText(prdMarkdown, SLACK_BLOCK_LIMIT);

  // Add the first chunk to the header message
  headerBlocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: prdChunks[0],
    },
  });

  // Post the main message
  const result = await client.chat.postMessage({
    channel: channelId,
    text: "📋 New PRD Generated from Meeting", // Fallback text for notifications
    blocks: headerBlocks,
  });

  const threadTs = result.ts;
  logger.info(ctx, "Header message posted", { ts: threadTs });

  // Post remaining chunks as threaded replies
  if (prdChunks.length > 1) {
    for (let i = 1; i < prdChunks.length; i++) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: prdChunks[i],
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: prdChunks[i],
            },
          },
        ],
      });

      // Small delay to avoid rate limits
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    logger.info(ctx, `Posted ${prdChunks.length - 1} additional thread messages`);
  }

  logger.info(ctx, "PRD posted to Slack successfully");
}

function buildMetadataLine(
  metadata?: {
    meetUrl?: string;
    meetingDuration?: string;
    participantCount?: number;
  },
): string {
  const parts: string[] = [
    `*Generated at:* ${new Date().toLocaleString()}`,
  ];
  if (metadata?.meetUrl) {
    parts.push(`*Meeting:* <${metadata.meetUrl}|Google Meet Link>`);
  }
  if (metadata?.meetingDuration) {
    parts.push(`*Duration:* ${metadata.meetingDuration}`);
  }
  if (metadata?.participantCount) {
    parts.push(`*Participants:* ${metadata.participantCount}`);
  }
  return parts.join("  |  ");
}

/**
 * Splits text into chunks of at most `maxLen` characters,
 * trying to break at paragraph boundaries.
 */
function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to break at a double newline (paragraph boundary)
    let breakPoint = remaining.lastIndexOf("\n\n", maxLen);
    if (breakPoint <= 0) {
      // Try a single newline
      breakPoint = remaining.lastIndexOf("\n", maxLen);
    }
    if (breakPoint <= 0) {
      // Try a space
      breakPoint = remaining.lastIndexOf(" ", maxLen);
    }
    if (breakPoint <= 0) {
      // Hard break
      breakPoint = maxLen;
    }

    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint).trimStart();
  }

  return chunks;
}
