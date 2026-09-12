import { createChannel } from "@copilotkit/channels";
import { isSearchConfigured, isWorkplaceConfigured, WORKPLACE_CONTEXT } from "agent-core";
import { makeChannelAgent } from "./agent";
import { required } from "./env";
import { MentionGroupCard, ReputationSummary, welcomeMessage } from "./components";
import { analyzeReputation, proposeEscalation, readThread, searchTheWeb } from "./tools";

// Tools are registered only when their credential is present, so the agent is
// never handed a tool that will fail when it calls it. analyze_reputation stays
// registered without Exa: the channel half of the evidence still works, and the
// sweep reports its own absence rather than failing.
const tools = [
  readThread,
  analyzeReputation,
  proposeEscalation,
  ...(isSearchConfigured() ? [searchTheWeb] : []),
];

export const channel = createChannel({
  // Must equal the Channel Code in Intelligence, character for character. A
  // mismatch leaves the Channel at "Waiting for runtime" and is validated at
  // startup, not here.
  name: required("CHANNEL_CODE"),

  // Required. "platform" derives the canonical user from provider + workspace +
  // platform user id. Do NOT move this onto CopilotRuntime — that one is for
  // web requests and must be absent on a Channels-only runtime.
  identifyUser: "platform",

  agent: makeChannelAgent,
  tools,
  components: [MentionGroupCard, ReputationSummary],

  // Injected into the agent's prompt on every run.
  context: [
    {
      description: "Rendering",
      value:
        "You can draw native UI by calling reputation_summary for the overall picture and mention_group_card for an individual group. Prefer them over prose whenever the answer has structure.",
    },
    ...(isSearchConfigured()
      ? []
      : [
          {
            description: "Search",
            value:
              "EXA_API_KEY is not configured, so no web sweep and no link fetching are available. You can still analyse complaints the team pastes into the channel as text. Say plainly that the open-web half is switched off rather than implying you searched.",
          },
        ]),
    ...(isWorkplaceConfigured()
      ? [{ description: "Workplace", value: WORKPLACE_CONTEXT }]
      : []),
    {
      description: "Surface",
      value:
        "This is a chat channel a support and product team works in. It is also an input: complaints and links the team pastes here are evidence, and carry the same weight as anything found by search. Assume others are reading and that some joined late.",
    },
    {
      description: "Escalation destination",
      value:
        "The team's tracker (Jira, Azure DevOps, Trello, or another) is configured per team over MCP. In this deployment nothing external is written: propose_escalation records a decision only.",
    },
  ],
});

// A mention subscribes the conversation, so the agent then follows along instead
// of needing to be @-mentioned every single turn.
channel.onMention(async ({ thread }) => {
  await thread.subscribe();
  await thread.runAgent();
});

// Non-mentioned turns only ever reach onMessage — gate them on the flag or the
// agent will answer every message in every channel it has been invited to.
channel.onMessage(async ({ thread }) => {
  if (await thread.isSubscribed()) {
    await thread.runAgent();
  }
});

channel.onWelcome(async ({ thread, platform }) => {
  await thread.post(welcomeMessage(platform));
});
