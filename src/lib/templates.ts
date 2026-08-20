// Space templates: each creates a space pre-seeded with structured draft pages.
// Content is BlockNote document JSON, built with the tiny helpers below.

type Inline = { type: "text"; text: string; styles: Record<string, boolean> };
type Blk = {
  id: string;
  type: string;
  props: Record<string, string | number | boolean>;
  content?: Inline[] | { type: "tableContent"; rows: { cells: Inline[][] }[] };
  children: Blk[];
};

let counter = 0;
const bid = () => `tpl-${++counter}`;

const t = (text: string, styles: Record<string, boolean> = {}): Inline => ({
  type: "text",
  text,
  styles,
});
const p = (...content: Inline[]): Blk => ({
  id: bid(),
  type: "paragraph",
  props: {},
  content,
  children: [],
});
const h = (level: number, text: string): Blk => ({
  id: bid(),
  type: "heading",
  props: { level },
  content: [t(text)],
  children: [],
});
const li = (...content: Inline[]): Blk => ({
  id: bid(),
  type: "bulletListItem",
  props: {},
  content,
  children: [],
});
const nli = (...content: Inline[]): Blk => ({
  id: bid(),
  type: "numberedListItem",
  props: {},
  content,
  children: [],
});
const chk = (text: string): Blk => ({
  id: bid(),
  type: "checkListItem",
  props: { checked: false },
  content: [t(text)],
  children: [],
});
const q = (text: string): Blk => ({
  id: bid(),
  type: "quote",
  props: {},
  content: [t(text)],
  children: [],
});
const code = (language: string, src: string): Blk => ({
  id: bid(),
  type: "codeBlock",
  props: { language },
  content: [t(src)],
  children: [],
});
const model = (kind: string, title: string): Blk => ({
  id: bid(),
  type: "model3d",
  props: { kind, title },
  children: [],
});
const table = (rows: string[][]): Blk => ({
  id: bid(),
  type: "table",
  props: {},
  content: {
    type: "tableContent",
    rows: rows.map((r) => ({ cells: r.map((c) => [t(c)]) })),
  },
  children: [],
});

export type TemplatePage = {
  title: string;
  children?: TemplatePage[];
  blocks: Blk[];
};

export type SpaceTemplate = {
  id: string;
  name: string;
  tagline: string;
  audience: string;
  kind: string;
  group: "simple" | "engineering";
  pages: TemplatePage[];
};

export const TEMPLATES: SpaceTemplate[] = [
  {
    id: "blank",
    name: "Blank",
    tagline: "One empty page. Bring your own structure.",
    audience: "Everyone",
    kind: "docs",
    group: "simple",
    pages: [{ title: "Introduction", blocks: [] }],
  },
  {
    id: "wiki",
    name: "Wiki",
    tagline: "A shared knowledge base for any team.",
    audience: "Everyone",
    kind: "wiki",
    group: "simple",
    pages: [
      {
        title: "Home",
        blocks: [
          p(t("What this wiki covers and who keeps it current. Link the three pages people need most right here.")),
          h(2, "Start here"),
          li(t("The most-asked question, answered on its own page.")),
          li(t("Who to ask about what.")),
        ],
      },
      {
        title: "How we work",
        blocks: [
          h(2, "Meetings"),
          p(t("Which ones exist, what each is for, and what happens if you skip it.")),
          h(2, "Decisions"),
          p(t("Where decisions get written down so they stop being re-argued.")),
        ],
      },
    ],
  },
  {
    id: "cookbook",
    name: "Cookbook",
    tagline: "Step-by-step recipes anyone can follow.",
    audience: "Everyone",
    kind: "cookbook",
    group: "simple",
    pages: [
      {
        title: "About this cookbook",
        blocks: [
          p(t("Short, self-contained recipes. Each one says what you need, what to do, and how to know it worked.")),
        ],
      },
      {
        title: "Recipe template",
        blocks: [
          p(t("Time: how long this takes. Difficulty: who can follow it.")),
          h(2, "What you need"),
          li(t("Access, tools, or files required before starting.")),
          h(2, "Steps"),
          nli(t("One action per step.")),
          nli(t("Include the exact command, click, or setting.")),
          h(2, "How to know it worked"),
          p(t("The check a reader performs to confirm success.")),
        ],
      },
    ],
  },
  {
    id: "notebook",
    name: "Notebook",
    tagline: "Longform write-ups, notes, and articles.",
    audience: "Everyone",
    kind: "articles",
    group: "simple",
    pages: [
      {
        title: "Write-up template",
        blocks: [
          q("Write the summary first. If the summary is boring, the write-up is not done."),
          h(2, "TL;DR"),
          p(t("Three sentences a busy reader can act on.")),
          h(2, "Background"),
          p(t("Only what the reader needs to follow the argument.")),
          h(2, "The details"),
          p(t("Evidence and reasoning, in the order that convinced you.")),
        ],
      },
    ],
  },
  {
    id: "product-docs",
    group: "engineering" as const,
    name: "Product documentation",
    tagline: "Overview, getting started, configuration, FAQ.",
    audience: "Software teams",
    kind: "docs",
    pages: [
      {
        title: "Overview",
        blocks: [
          p(t("One paragraph on what this product does and who it is for. Lead with the problem it removes, not the feature list.")),
          h(2, "Core concepts"),
          p(t("Define the three to five nouns a reader must understand before anything else makes sense.")),
          h(2, "Architecture at a glance"),
          model("architecture", "How the pieces fit"),
          code("mermaid", "flowchart LR\n  Client --> API\n  API --> DB[(Database)]\n  API --> Worker\n  Worker --> Queue[(Queue)]"),
        ],
      },
      {
        title: "Getting started",
        blocks: [
          p(t("The shortest path from zero to a working result. Target: under ten minutes.")),
          h(2, "Prerequisites"),
          li(t("Requirement one, with the exact version.")),
          li(t("Requirement two.")),
          h(2, "Install"),
          code("bash", "# install command here"),
          h(2, "First run"),
          nli(t("Step one.")),
          nli(t("Step two.")),
          nli(t("Verify: what the reader should see if it worked.")),
        ],
      },
      {
        title: "Configuration",
        blocks: [
          p(t("Every setting, its default, and when to change it.")),
          table([
            ["Setting", "Default", "When to change"],
            ["EXAMPLE_VAR", "true", "Describe the trade-off."],
          ]),
        ],
      },
      {
        title: "FAQ",
        blocks: [
          h(2, "Question that actually gets asked?"),
          p(t("A direct answer, then the link to the deeper page.")),
        ],
      },
    ],
  },
  {
    id: "sre-runbook",
    group: "engineering" as const,
    name: "SRE runbooks",
    tagline: "Alert-driven runbooks with a postmortem template.",
    audience: "SRE, on-call engineers",
    kind: "cookbook",
    pages: [
      {
        title: "Service overview",
        blocks: [
          p(t("What this service does, its SLOs, and where the dashboards live. This is the page an unfamiliar responder reads at 3 a.m.")),
          model("architecture", "What this service talks to"),
          h(2, "SLOs"),
          table([
            ["SLI", "Objective", "Window"],
            ["Availability", "99.9%", "30 days"],
            ["p99 latency", "< 400 ms", "30 days"],
          ]),
          h(2, "Key links"),
          li(t("Dashboard: ")),
          li(t("Alert policy: ")),
          li(t("Escalation: ")),
        ],
      },
      {
        title: "Runbooks",
        blocks: [
          p(t("One child page per alert. Keep the diagnosis steps copy-pasteable.")),
        ],
        children: [
          {
            title: "Runbook: high error rate",
            blocks: [
              h(2, "Symptoms"),
              p(t("What fires, what the user sees.")),
              h(2, "Impact"),
              p(t("Who is affected and how badly. Be specific enough to justify paging.")),
              h(2, "Diagnosis"),
              nli(t("Check the obvious first:")),
              code("bash", "kubectl get pods -n service --field-selector=status.phase!=Running"),
              nli(t("Then the recent deploys:")),
              code("bash", "kubectl rollout history deploy/service -n service"),
              h(2, "Mitigation"),
              p(t("The safest action that restores service, even if it is not the fix.")),
              code("bash", "kubectl rollout undo deploy/service -n service"),
              h(2, "Escalation"),
              p(t("Who to wake up, and after how long.")),
            ],
          },
        ],
      },
      {
        title: "Postmortem template",
        blocks: [
          q("Blameless means the sentence names a system, not a person."),
          h(2, "Summary"),
          p(t("Two sentences: what broke, for how long, who was affected.")),
          h(2, "Timeline"),
          table([
            ["Time (UTC)", "Event"],
            ["", "First alert fired"],
            ["", "Mitigation applied"],
            ["", "Resolved"],
          ]),
          h(2, "Root cause"),
          p(t("The mechanism, not the trigger.")),
          h(2, "Action items"),
          chk("Fix with an owner and a date"),
          chk("Detection improvement"),
          chk("Process change"),
        ],
      },
    ],
  },
  {
    id: "devops-playbook",
    group: "engineering" as const,
    name: "DevOps playbook",
    tagline: "Pipelines, deploy recipes, environments, rollbacks.",
    audience: "DevOps, platform engineers",
    kind: "cookbook",
    pages: [
      {
        title: "Pipeline overview",
        blocks: [
          model("pipeline", "The delivery pipeline"),
          p(t("Drag to orbit — the parallel test lanes sit behind the main line.")),
          code("mermaid", "flowchart LR\n  PR[Pull request] --> CI[CI: lint + test]\n  CI --> Build[Build image]\n  Build --> Stage[Deploy staging]\n  Stage --> Gate{Approval}\n  Gate --> Prod[Deploy production]"),
          h(2, "Stages"),
          p(t("What runs at each stage, how long it takes, and what failure at that stage means.")),
        ],
      },
      {
        title: "Environment matrix",
        blocks: [
          table([
            ["Environment", "URL", "Deploys from", "Data"],
            ["dev", "", "every merge", "synthetic"],
            ["staging", "", "release branch", "scrubbed copy"],
            ["production", "", "tagged release", "live"],
          ]),
        ],
      },
      {
        title: "Recipe: deploy to production",
        blocks: [
          h(2, "Preconditions"),
          chk("Staging green for 30 minutes"),
          chk("No open incident"),
          h(2, "Steps"),
          nli(t("Tag the release.")),
          code("bash", "git tag -a v1.2.3 -m 'release' && git push --tags"),
          nli(t("Watch the rollout.")),
          h(2, "Rollback"),
          p(t("The rollback command, tested, on one line:")),
          code("bash", "# rollback command here"),
        ],
      },
    ],
  },
  {
    id: "api-reference",
    group: "engineering" as const,
    name: "API reference",
    tagline: "Auth, endpoints, errors — with request samples.",
    audience: "Backend, API teams",
    kind: "docs",
    pages: [
      {
        title: "Authentication",
        blocks: [
          p(t("How to get a token and how to send it.")),
          code("bash", 'curl -H "Authorization: Bearer $TOKEN" https://api.example.com/v1/me'),
        ],
      },
      {
        title: "Endpoints",
        blocks: [
          h(2, "GET /v1/things"),
          p(t("What it returns and when to use it.")),
          table([
            ["Parameter", "Type", "Required", "Description"],
            ["limit", "integer", "no", "Max results, default 20."],
          ]),
          code("json", '{\n  "data": [],\n  "next_cursor": null\n}'),
        ],
      },
      {
        title: "Errors",
        blocks: [
          table([
            ["Code", "Meaning", "What to do"],
            ["401", "Bad or missing token", "Re-authenticate."],
            ["429", "Rate limited", "Back off; honor Retry-After."],
          ]),
        ],
      },
    ],
  },
  {
    id: "data-science",
    group: "engineering" as const,
    name: "Data science project",
    tagline: "Charter, data dictionary, experiment log, model card.",
    audience: "Data scientists, ML engineers",
    kind: "docs",
    pages: [
      {
        title: "Project charter",
        blocks: [
          model("embedding", "Embedding space"),
          p(t("Drag to orbit. Useful for showing what separates — and what does not — before the metrics arrive.")),
          h(2, "Question"),
          p(t("The decision this analysis informs — not the dataset, the decision.")),
          h(2, "Success criteria"),
          li(t("Metric and threshold that makes this shippable.")),
          h(2, "Non-goals"),
          li(t("What this project deliberately does not attempt.")),
        ],
      },
      {
        title: "Data dictionary",
        blocks: [
          table([
            ["Column", "Type", "Source", "Notes"],
            ["", "", "", ""],
          ]),
          q("Every column you do not document becomes a Slack thread later."),
        ],
      },
      {
        title: "Experiment log",
        blocks: [
          p(t("One entry per run. Newest first. Never edit old entries.")),
          h(2, "2026-01-01 — baseline"),
          table([
            ["Model", "Features", "Metric", "Result"],
            ["", "", "", ""],
          ]),
          code("python", "# exact command or notebook cell that produced this result"),
        ],
      },
      {
        title: "Model card",
        blocks: [
          h(2, "Intended use"),
          p(t("What it predicts, for whom, and the contexts it must not be used in.")),
          h(2, "Training data"),
          p(t("Provenance, date range, known gaps.")),
          h(2, "Evaluation"),
          p(t("Held-out performance, sliced by the segments that matter.")),
          h(2, "Limitations"),
          li(t("Known failure modes.")),
        ],
      },
    ],
  },
  {
    id: "network-eng",
    group: "engineering" as const,
    name: "Network engineering",
    tagline: "Topology, device inventory, change requests.",
    audience: "Network, infrastructure engineers",
    kind: "docs",
    pages: [
      {
        title: "Topology",
        blocks: [
          model("network", "The network, in three dimensions"),
          p(t("Drag to orbit. A flat diagram of the same network follows — keep whichever reads better for your team.")),
          code("mermaid", "flowchart TB\n  WAN((WAN)) --> FW[Firewall]\n  FW --> CORE[Core switch]\n  CORE --> A[Access switch A]\n  CORE --> B[Access switch B]\n  CORE --> SRV[Server VLAN]"),
          h(2, "Addressing plan"),
          table([
            ["VLAN", "Subnet", "Purpose"],
            ["10", "10.0.10.0/24", "Servers"],
            ["20", "10.0.20.0/24", "Clients"],
          ]),
        ],
      },
      {
        title: "Device inventory",
        blocks: [
          table([
            ["Hostname", "Model", "Mgmt IP", "Location", "Firmware"],
            ["", "", "", "", ""],
          ]),
        ],
      },
      {
        title: "Change request template",
        blocks: [
          h(2, "Change"),
          p(t("What is changing, in one sentence.")),
          h(2, "Risk and blast radius"),
          p(t("What breaks if this goes wrong, and who notices.")),
          h(2, "Procedure"),
          nli(t("Step, with the exact commands:")),
          code("text", "conf t\n! commands here\nend\nwrite mem"),
          h(2, "Verification"),
          chk("Ping test from affected VLANs"),
          chk("Monitoring green for 15 minutes"),
          h(2, "Rollback"),
          code("text", "! exact rollback commands"),
        ],
      },
    ],
  },
  {
    id: "ai-engineering",
    group: "engineering" as const,
    name: "AI engineering",
    tagline: "System cards, eval playbooks, prompt registry.",
    audience: "AI, ML platform engineers",
    kind: "docs",
    pages: [
      {
        title: "System card",
        blocks: [
          model("architecture", "The system, end to end"),
          p(t("Drag to orbit. Keep it current — a system card whose diagram has rotted is worse than none.")),
          h(2, "What this system does"),
          p(t("The task, the model(s) behind it, and the boundary of what it is allowed to decide on its own.")),
          h(2, "Models in use"),
          table([
            ["Component", "Model", "Version pin", "Fallback"],
            ["", "", "", ""],
          ]),
          h(2, "Guardrails"),
          li(t("Input filtering and why it exists.")),
          li(t("Output checks before anything reaches a user or a tool.")),
          h(2, "Known failure modes"),
          li(t("The way it breaks, how often, and how you detect it.")),
        ],
      },
      {
        title: "Eval playbook",
        blocks: [
          p(t("Every behavior you care about gets an eval. No eval, no claim.")),
          h(2, "Suites"),
          table([
            ["Suite", "What it measures", "Pass bar", "Runs on"],
            ["", "", "", "every PR / nightly"],
          ]),
          h(2, "Running locally"),
          code("bash", "# exact command that reproduces the score in the table above"),
          h(2, "Regression log"),
          p(t("Newest first. What dropped, which change caused it, what fixed it.")),
        ],
      },
      {
        title: "Prompt registry",
        blocks: [
          p(t("Prompts are code. Version them, diff them, and record why each change shipped.")),
          h(2, "prompt: example-task v3"),
          table([
            ["Version", "Date", "Change", "Eval delta"],
            ["v3", "", "", ""],
          ]),
          code("text", "You are…\n\n# paste the full prompt here — the registry is the source of truth"),
        ],
      },
    ],
  },
  {
    id: "bio-compute",
    group: "engineering" as const,
    name: "Biological compute",
    tagline: "Study docs, wet-lab protocols, culture and session logs.",
    audience: "Wetware, neuro, biomedical engineers",
    kind: "docs",
    pages: [
      {
        title: "Study overview",
        blocks: [
          model("culture", "Culture over the electrode array"),
          p(t("Drag to orbit the culture. Swap in your own array geometry, or add a molecular model beside it.")),
          h(2, "Hypothesis"),
          p(t("The claim this study can actually falsify.")),
          h(2, "Endpoints"),
          li(t("Primary endpoint and the measurement that decides it.")),
          li(t("Secondary endpoints.")),
          h(2, "Ethics and provenance"),
          p(t("Tissue source, approvals, and disposal path. Write it before the first culture, not after.")),
        ],
      },
      {
        title: "Protocol",
        blocks: [
          p(t("Version this page like code — a protocol change mid-study is a finding, not a footnote.")),
          model("molecule", "The construct"),
          h(2, "Materials"),
          table([
            ["Item", "Spec / lot", "Storage"],
            ["", "", ""],
          ]),
          h(2, "Procedure"),
          nli(t("Step, with exact volumes, temperatures, and timings.")),
          nli(t("Step.")),
          h(2, "Safety"),
          li(t("Hazards and the response for each.")),
        ],
      },
      {
        title: "Culture log",
        blocks: [
          p(t("One row per observation. Never backfill from memory.")),
          table([
            ["Date", "DIV", "Media change", "Observation", "By"],
            ["", "", "", "", ""],
          ]),
        ],
      },
      {
        title: "Recording session notes",
        blocks: [
          h(2, "Session parameters"),
          table([
            ["Parameter", "Value"],
            ["Array / electrode map", ""],
            ["Sample rate", ""],
            ["Stimulus protocol", ""],
            ["Duration", ""],
          ]),
          h(2, "Analysis"),
          code("python", "# exact analysis snippet or notebook reference that produced the figures"),
          h(2, "Anomalies"),
          p(t("Anything that would make you distrust this session's data.")),
        ],
      },
    ],
  },
  {
    id: "adr",
    group: "engineering" as const,
    name: "Architecture decisions",
    tagline: "ADRs: context, decision, consequences.",
    audience: "Systems engineers, architects, staff+",
    kind: "docs",
    pages: [
      {
        title: "How we decide",
        blocks: [
          p(t("One page per decision. Decisions are immutable — superseding one means writing a new ADR that links back.")),
          model("architecture", "The system this record governs"),
          p(t("Drag the model to orbit it. Swap it for your own architecture, or delete the block — it is a normal block.")),
          table([
            ["Status", "Meaning"],
            ["Proposed", "Under discussion"],
            ["Accepted", "In force"],
            ["Superseded", "Replaced — link to the successor"],
          ]),
        ],
      },
      {
        title: "ADR-001: example decision",
        blocks: [
          p(t("Status: ", { bold: true }), t("Proposed")),
          h(2, "Context"),
          p(t("The forces at play: constraints, requirements, and what happens if we do nothing.")),
          h(2, "Decision"),
          p(t("The choice, stated in the active voice: we will…")),
          h(2, "Alternatives considered"),
          li(t("Alternative, and the one reason it lost.")),
          h(2, "Consequences"),
          li(t("What gets easier.")),
          li(t("What gets harder, and who pays that cost.")),
        ],
      },
    ],
  },
];

export function getTemplate(id: string): SpaceTemplate {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}
