/**
 * Agent-rendered components for the reputation agent.
 *
 * `defineChannelComponent` turns a component into a tool the agent can call to
 * draw UI itself. A group of complaints has a shape — how many, from how many
 * places, how urgent — and a card carries that shape in one glance where a
 * paragraph makes the reader reconstruct it.
 *
 * One tree renders as Slack Block Kit, Teams Adaptive Cards, and Discord
 * components. A surface that cannot render a node skips it rather than failing.
 *
 * Every tag and prop below comes from
 * .agents/skills/build-channels-agent/references/ui-components.md.
 */
import {
  defineChannelComponent,
  Message,
  Header,
  Section,
  Markdown,
  Fields,
  Field,
  Context,
  Divider,
  Actions,
  Button,
  Table,
  Row,
  Cell,
} from "@copilotkit/channels";
import { z } from "zod";

/** Priority drives the colour rail, so the channel can triage by glance. */
const PRIORITY = {
  alta: { accent: "#C4145F", label: "Prioridad alta" },
  media: { accent: "#8A5C10", label: "Prioridad media" },
  baja: { accent: "#5B6478", label: "Prioridad baja" },
} as const;

/** An incident overrides the priority rail — it is the loudest thing on screen. */
const INCIDENT_ACCENT = "#B3261E";

const prioridadSchema = z.enum(["baja", "media", "alta"]);

const fuenteSchema = z.object({
  titulo: z.string().describe("Short label for the source, as it will be read on the button."),
  url: z.string().describe("The original URL of the mention."),
});

/**
 * One group of mentions that describe the same failure.
 *
 * `fuentes_distintas` is shown next to `menciones` on purpose: ten complaints on
 * one forum thread and ten across five sites mean very different things, and the
 * incident rule treats them differently too.
 */
export const MentionGroupCard = defineChannelComponent({
  name: "mention_group_card",
  description:
    "Draw one group of complaints that describe the same problem. Call this for each group worth the channel's attention, and always for any group marked as an incident. Prefer it over describing a group in prose. Pass the counts and the incident flag exactly as the analysis returned them — do not recompute or round them.",
  parameters: z.object({
    descripcion: z
      .string()
      .describe("The shared problem in one sentence, in the target language."),
    prioridad: prioridadSchema.describe(
      "Highest priority among the mentions in this group. Never higher than 'alta'.",
    ),
    menciones: z.number().int().min(1).describe("How many mentions are in this group."),
    fuentes_distintas: z
      .number()
      .int()
      .min(0)
      .describe("How many distinct sources the mentions came from."),
    es_incidente: z
      .boolean()
      .default(false)
      .describe(
        "Whether the incident rule marked this group. This is computed, never your own judgement — copy what the analysis returned.",
      ),
    fuentes: z
      .array(fuenteSchema)
      .max(8)
      .default([])
      .describe("Links to the original mentions, so a reader can check them."),
  }),
  render({ descripcion, prioridad, menciones, fuentes_distintas, es_incidente, fuentes }) {
    const nivel = PRIORITY[prioridad];
    return (
      <Message accent={es_incidente ? INCIDENT_ACCENT : nivel.accent}>
        <Header>{es_incidente ? `⚠ Incidente — ${descripcion}` : descripcion}</Header>
        <Context>{es_incidente ? `${nivel.label} · cruzó el umbral de incidente` : nivel.label}</Context>
        <Fields>
          <Field label="Menciones">{String(menciones)}</Field>
          <Field label="Fuentes distintas">{String(fuentes_distintas)}</Field>
        </Fields>
        {fuentes.length > 0 && <Divider />}
        {fuentes.map((fuente, index) => (
          <Actions>
            <Button url={fuente.url}>{`${index + 1}. ${fuente.titulo}`}</Button>
          </Actions>
        ))}
        {fuentes.length === 0 && (
          <Context>
            Sin enlaces públicos: estas menciones llegaron como texto en el canal.
          </Context>
        )}
      </Message>
    );
  },
});

const PRIORITY_ORDER = { alta: 0, media: 1, baja: 2 } as const;

/**
 * The whole picture, incidents first.
 *
 * The ordering is enforced here rather than trusted to the model, because the
 * first row is the one that gets read and the rest often do not.
 */
export const ReputationSummary = defineChannelComponent({
  name: "reputation_summary",
  description:
    "Draw the overall picture for a company: every group, incidents first and then by priority. Call this once per analysis, after the groups exist. Use mention_group_card for the detail of an individual group.",
  parameters: z.object({
    empresa: z.string().describe("The company the analysis was about."),
    grupos: z
      .array(
        z.object({
          descripcion: z.string(),
          prioridad: prioridadSchema,
          menciones: z.number().int().min(1),
          fuentes_distintas: z.number().int().min(0),
          es_incidente: z.boolean().default(false),
        }),
      )
      .min(1)
      .max(15)
      .describe("All groups from this analysis, including groups of a single mention."),
    nota: z
      .string()
      .optional()
      .describe(
        "One line about gaps in the sweep: sources that could not be read, or a search that returned nothing. Omit when there is nothing to report.",
      ),
  }),
  render({ empresa, grupos, nota }) {
    const ordenados = [...grupos].sort((a, b) => {
      if (a.es_incidente !== b.es_incidente) return a.es_incidente ? -1 : 1;
      if (a.prioridad !== b.prioridad) {
        return PRIORITY_ORDER[a.prioridad] - PRIORITY_ORDER[b.prioridad];
      }
      return b.menciones - a.menciones;
    });
    const incidentes = ordenados.filter((grupo) => grupo.es_incidente).length;
    const totalMenciones = ordenados.reduce((sum, grupo) => sum + grupo.menciones, 0);

    return (
      <Message accent={incidentes > 0 ? INCIDENT_ACCENT : "#5B6478"}>
        <Header>{`Reputación de ${empresa}`}</Header>
        <Context>
          {`${totalMenciones} mención(es) · ${ordenados.length} grupo(s) · ${incidentes} incidente(s)`}
        </Context>
        <Table
          columns={[
            { header: "Problema" },
            { header: "Prioridad" },
            { header: "Menciones" },
            { header: "Fuentes" },
          ]}
        >
          {ordenados.map((grupo) => (
            <Row>
              <Cell>{grupo.es_incidente ? `⚠ ${grupo.descripcion}` : grupo.descripcion}</Cell>
              <Cell>{grupo.prioridad}</Cell>
              <Cell>{String(grupo.menciones)}</Cell>
              <Cell>{String(grupo.fuentes_distintas)}</Cell>
            </Row>
          ))}
        </Table>
        {incidentes > 0 && (
          <Section>
            <Markdown>
              {`*⚠ ${incidentes} grupo(s) cruzaron el umbral de incidente.* Revisa si vale escalarlos a una tarea.`}
            </Markdown>
          </Section>
        )}
        {nota && <Divider />}
        {nota && <Context>{nota}</Context>}
      </Message>
    );
  },
});

/**
 * The welcome message. A bot that says nothing when invited looks broken; one
 * that says what it will do on its own gets used.
 *
 * It leads with the paste-it-here path because that is the part nobody expects
 * a monitoring bot to have, and the part that makes the channel worth being in.
 */
export function welcomeMessage(platform: string) {
  return (
    <Message accent="#C4145F">
      <Header>Monitor de reputación, en el canal</Header>
      <Section>
        <Markdown>
          {"Busco quejas sobre una empresa en foros y en la web abierta, en varios idiomas, " +
            "las agrupo por problema y te aviso cuando un grupo se vuelve un incidente. " +
            `Este ${platform} es donde trabajo, no solo donde respondo.`}
        </Markdown>
      </Section>
      <Fields>
        <Field label="Pídeme un análisis">
          Menciónname con el nombre de la empresa y el idioma de respuesta
        </Field>
        <Field label="O aliméntame">
          Pega aquí quejas que encontraste tú, en texto o como enlace
        </Field>
      </Fields>
      <Section>
        <Markdown>
          {"Lo que pegas en el canal pesa igual que lo que encuentro yo. Así cubrimos redes " +
            "sociales sin pagar sus APIs: tú descubres, yo analizo."}
        </Markdown>
      </Section>
      <Context>
        Escalar a una tarea es siempre una propuesta con clic. No ejecuto nada fuera de aquí.
      </Context>
      <Actions>
        <Button
          value="analizar"
          style="primary"
          onClick={async ({ thread }) => {
            await thread.runAgent({
              prompt:
                "Lee este canal. Si ya hay quejas o enlaces pegados, analízalos y muéstrame el resumen de reputación. Si no hay nada todavía, pregúntame el nombre de la empresa y el idioma de respuesta.",
            });
          }}
        >
          Analizar lo que hay en el canal
        </Button>
      </Actions>
    </Message>
  );
}
