/**
 * The reputation agent's tools.
 *
 * A channel tool handler receives the LIVE thread, which is what makes the
 * proposal below possible: it posts a card and returns. A later click reports
 * the decision; it does not resume the agent or execute an action.
 *
 * The return value is what the *agent* reads back, not what the user sees.
 * Return raw data (it is JSON-stringified for you) or a short natural-language
 * confirmation — never `{ ok: true }`, and never hand-stringify.
 */
import {
  defineChannelTool,
  Message,
  Header,
  Section,
  Markdown,
  Context,
  Fields,
  Field,
  Actions,
  Button,
} from "@copilotkit/channels";
import type { InteractionContext } from "@copilotkit/channels";
export { searchTheWeb } from "./search";
export { analyzeReputation } from "./analyze";
import { z } from "zod";

/**
 * Read the complaints the team has already gathered here.
 *
 * This is not a convenience tool. Half the evidence in this project arrives by
 * a human pasting it into the channel — the posts behind logins and on platforms
 * whose APIs cost money. Skipping this tool does not merely lose context, it
 * loses an entire source of mentions.
 */
export const readThread = defineChannelTool({
  name: "read_thread",
  description:
    "Read the recent messages in this conversation. Call this on EVERY analysis, before answering — this channel is a source of evidence, not just a place to reply. The team pastes complaints here as quoted text and as links, usually from platforms you cannot search yourself. Those mentions carry exactly the same weight as anything you find with search_web and are grouped by the same rules. An analysis that skips this tool is missing data, not just context.",
  parameters: z.object({}),
  async handler(_args, { thread }) {
    const messages = await thread.getMessages();
    if (messages.length === 0) {
      return "This surface does not expose conversation history, or the channel is empty. Say that you cannot see earlier messages, and ask the team to paste any complaints they already have directly in their next message.";
    }
    return messages;
  },
});

/**
 * Managed delivery cannot block on awaitChoice. Post a proposal and let a later
 * interaction report the decision. This demo has no tracker executor.
 * Inline handlers require one listener instance that stays running until click.
 */
export const proposeEscalation = defineChannelTool({
  name: "propose_escalation",
  description:
    "Propose escalating a group of complaints into a work item for the team's tracker. Call this when a group has crossed the incident threshold, once per group, and stop after posting. This returns pending immediately — it is not approval. Do not call write tools, and do not claim a task was created. The destination tracker (Jira, Azure DevOps, Trello, or whatever the team uses) is configured per team over MCP; in this demo a click only records the decision and creates nothing anywhere.",
  parameters: z.object({
    problema: z
      .string()
      .describe("The problem to escalate, in one plain sentence, in the target language."),
    prioridad: z
      .enum(["baja", "media", "alta"])
      .describe("Highest priority among the group's mentions. Never higher than 'alta'."),
    menciones: z
      .number()
      .int()
      .min(1)
      .describe("How many mentions back this group. Copy it from the analysis."),
    fuentes: z
      .array(z.string())
      .max(8)
      .default([])
      .describe("URLs of the original mentions, so a reviewer can check them before deciding."),
  }),
  async handler({ problema, prioridad, menciones, fuentes }, { thread }) {
    // The SDK retains inline action handlers after a message replacement. Queue
    // clicks and settle only after a successful update, so stale/opposite clicks
    // cannot overwrite a decision and a failed update remains retryable.
    let settled = false;
    let previousReport = Promise.resolve();
    const reportDecision = (
      approved: boolean,
      ctx: InteractionContext<boolean>,
    ) => {
      const report = async () => {
        if (settled) return;
        const decision = approved
          ? "Escalamiento aprobado. No se creó ninguna tarea: el destino se configura por MCP y esta demo no ejecuta escrituras externas."
          : "Descartado por el equipo. No se creó ninguna tarea. No insistas ni ofrezcas un rodeo.";
        // Use the interaction's thread, whose delivery is live now.
        await ctx.thread.update(
          ctx.message.ref,
          `${decision}\n\nPropuesta: ${problema}`,
        );
        settled = true;
      };
      previousReport = previousReport.then(report, report);
      return previousReport;
    };

    await thread.post(
      <Message accent="#B3261E">
        <Header>Escalar a tarea de trabajo</Header>
        <Section>
          <Markdown>{`**${problema}**`}</Markdown>
        </Section>
        <Fields>
          <Field label="Prioridad">{prioridad}</Field>
          <Field label="Menciones">{String(menciones)}</Field>
        </Fields>
        {fuentes.map((url, index) => (
          <Actions>
            <Button url={url}>{`Fuente ${index + 1}`}</Button>
          </Actions>
        ))}
        <Context>
          El destino (Jira, Azure DevOps, Trello…) se configura por MCP según el equipo.
        </Context>
        <Context>
          Propuesta de demo. El clic registra la decisión; no crea nada en ningún sistema.
        </Context>
        <Actions>
          <Button
            value={true}
            style="primary"
            onClick={async (ctx) => {
              await reportDecision(true, ctx);
            }}
          >
            Aprobar
          </Button>
          <Button
            value={false}
            style="danger"
            onClick={async (ctx) => {
              await reportDecision(false, ctx);
            }}
          >
            Descartar
          </Button>
        </Actions>
      </Message>,
    );

    return "Propuesta de escalamiento publicada; decisión pendiente. Detente aquí. No crees la tarea, no llames herramientas de escritura y no ofrezcas un rodeo. Un clic posterior solo registra la decisión: no ejecuta nada y no te reanuda automáticamente.";
  },
});
