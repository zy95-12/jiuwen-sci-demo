#!/usr/bin/env node
import { Command } from "commander";
import type { RuntimeEvent, RuntimeRunResult } from "@jiuwen-sci/core";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

ensureExperimentalSqlite();

type GlobalOptions = {
  cd?: string;
  model?: string;
  brief?: string;
  config?: string[];
  approval?: string;
  sandbox?: string;
  strategy?: string;
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
};

type ResearchBrief = {
  topic?: string;
  intent?: string;
  scope?: { include?: string[]; exclude?: string[] };
  focus?: { questions?: string[]; domains?: string[]; institutions?: string[]; geographies?: string[] };
  sources?: { databases?: string[]; preferred_sources?: string[]; exclude_sources?: string[]; date_range?: { from?: string | number; to?: string | number } };
  evidence?: { study_types?: string[]; min_quality?: string; require_doi?: boolean; require_abstract?: boolean };
  output?: { language?: string; format?: string; depth?: string; max_papers?: number; include?: string[] };
  notes?: string[];
};

type InteractiveState = {
  brief?: ResearchBrief;
};

const program = new Command();

program
  .name("jiuwen-sci")
  .description("CLI-first scientific Agent Runtime")
  .version("0.1.0")
  .option("-C, --cd <path>", "set working directory")
  .option("-m, --model <provider:model>", "model to use")
  .option("--brief <file>", "load a readable research brief JSON/YAML file")
  .option("-c, --config <key=value...>", "override config")
  .option("-a, --approval <mode>", "approval mode: on-request | never | always")
  .option("--sandbox <mode>", "sandbox mode: none | readonly | workspace-write")
  .option("--strategy <strategy>", "execution strategy: direct | retry | critic_revise | workflow_controlled | auto")
  .option("--json", "output JSON")
  .option("--verbose", "verbose output")
  .option("--quiet", "quiet output");

program.argument("[prompt]", "start interactive mode with optional initial prompt").action(async (prompt?: string) => {
  if (prompt) {
    await runExec(prompt, { strategy: program.opts<GlobalOptions>().strategy ?? "auto" });
    return;
  }
  await runInteractive();
});

program.command("init").description("initialize local jiuwen-sci state").action(async () => {
  const opts = program.opts<GlobalOptions>();
  const cwd = path.resolve(opts.cd ?? process.cwd());
  const root = path.join(cwd, ".jiuwen-sci");
  await mkdir(path.join(root, "artifacts"), { recursive: true });
  await mkdir(path.join(root, "logs"), { recursive: true });
  await mkdir(path.join(root, "cache"), { recursive: true });
  await writeFile(path.join(root, "config.toml"), 'default_model = "mock:deterministic"\n', { flag: "a" });
  console.log(`Initialized ${root}`);
});

program.command("exec")
  .description("run a non-interactive task")
  .argument("<prompt>", "task prompt")
  .option("--strategy <strategy>", "execution strategy", "auto")
  .option("--max-retries <n>", "maximum retries")
  .option("--max-review-rounds <n>", "maximum review rounds")
  .option("--brief <file>", "load a readable research brief JSON/YAML file")
  .action(async (prompt: string, options: any) => runExec(prompt, options));

program.command("resume")
  .description("resume a previous session")
  .argument("<session>", "session id")
  .action(async (sessionId: string) => {
    const opts = program.opts<GlobalOptions>();
    const runtime = await makeRuntime(opts);
    await runtime.start();
    try {
      const result = await runtime.resume(sessionId);
      printRunResult(result, opts);
    } finally {
      await runtime.stop();
    }
  });

program.command("doctor").description("diagnose local jiuwen-sci setup").action(async () => {
  const opts = program.opts<GlobalOptions>();
  const runtime = await makeRuntime(opts);
  const checks: { name: string; ok: boolean; message: string }[] = [];
  checks.push({ name: "Node", ok: Number(process.versions.node.split(".")[0]) >= 22, message: process.version });
  checks.push({ name: "SQLite", ok: true, message: "node:sqlite available; run with --experimental-sqlite on Node 22" });
  await runtime.start();
  try {
    checks.push({ name: "Runtime DB", ok: true, message: runtime.services.config.paths.database });
    checks.push({ name: "Artifacts", ok: true, message: runtime.services.config.paths.artifacts });
    checks.push({ name: "Default model", ok: true, message: `${runtime.services.config.defaultModel.provider}:${runtime.services.config.defaultModel.model}` });
    checks.push({ name: "OPENAI_API_KEY", ok: true, message: process.env.OPENAI_API_KEY ? "set" : "missing; checking ark-helper fallback" });
    checks.push({ name: "Ark helper", ok: true, message: existsSync("/root/.ark-helper/config.yaml") ? "found; using Volcengine Coding Plan fallback" : "missing" });
    checks.push({ name: "Literature pack", ok: true, message: runtime.services.packRegistry.list().map((p) => p.id).join(", ") });
  } finally {
    await runtime.stop();
  }
  for (const c of checks) console.log(`${c.ok ? "OK" : "FAIL"} ${c.name}: ${c.message}`);
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
});

const session = program.command("session").description("inspect sessions");
session.command("list").option("--limit <n>", "limit", "20").action(async (options: any) => {
  await withStartedRuntime(async (runtime, opts) => {
    const rows = await runtime.services.sessionStore.list(Number(options.limit));
    print(rows.map((s) => ({ id: s.id, parentId: s.parentId, agentId: s.agentId, status: s.status, title: s.title, createdAt: s.createdAt })), opts);
  });
});
session.command("show").argument("<session>").action(async (id: string) => {
  await withStartedRuntime(async (runtime, opts) => print(await runtime.services.sessionStore.get(id), opts));
});
session.command("tree").argument("<session>").action(async (id: string) => {
  await withStartedRuntime(async (runtime, opts) => {
    const root = await runtime.services.sessionStore.get(id);
    if (!root) throw new Error(`Session not found: ${id}`);
    const lines: string[] = [];
    async function walk(sessionId: string, indent: string): Promise<void> {
      const s = await runtime.services.sessionStore.get(sessionId);
      if (!s) return;
      lines.push(`${indent}${s.id} ${s.agentId} ${s.status} ${s.title}`);
      for (const child of await runtime.services.sessionStore.children(sessionId)) await walk(child.id, `${indent}  `);
    }
    await walk(root.id, "");
    print(lines.join("\n"), opts);
  });
});

const artifact = program.command("artifact").description("inspect artifacts");
artifact.command("list").option("--session <session>", "session id").action(async (options: any) => {
  await withStartedRuntime(async (runtime, opts) => {
    const rows = options.session ? await runtime.services.artifactStore.listBySession(options.session) : await runtime.services.artifactStore.listAll();
    print(rows.map((a) => ({ id: a.id, sessionId: a.sessionId, type: a.type, mediaType: a.mediaType, size: a.size, path: a.path, createdAt: a.createdAt })), opts);
  });
});
artifact.command("cat").argument("<artifact>").action(async (id: string) => {
  await withStartedRuntime(async (runtime) => {
    process.stdout.write((await runtime.services.artifactStore.read(id)).toString("utf8"));
  });
});

program.command("provenance")
  .description("inspect provenance")
  .command("trace")
  .argument("<ref>")
  .action(async (ref: string) => {
    await withStartedRuntime(async (runtime, opts) => print(await runtime.services.provenanceStore.trace(ref), opts));
  });

const review = program.command("review").description("inspect review findings");
review.command("list").requiredOption("--session <session>", "session id").action(async (options: any) => {
  await withStartedRuntime(async (runtime, opts) => print(await runtime.services.reviewStore.listBySession(options.session), opts));
});

program.command("pack").description("inspect capability packs").command("list").action(async () => {
  await withStartedRuntime(async (runtime, opts) => {
    print(runtime.services.packRegistry.list().map((p) => ({ id: p.id, name: p.name, version: p.version })), opts);
  });
});

const literature = program.command("literature").description("literature research workflows");
literature.command("review")
  .description("run a literature review workflow")
  .argument("<question>", "research question")
  .option("--db <ids>", "comma separated db ids")
  .option("--limit <n>", "result limit")
  .option("--strategy <strategy>", "execution strategy", "workflow_controlled")
  .option("--max-review-rounds <n>", "maximum review rounds")
  .option("--brief <file>", "load a readable research brief JSON/YAML file")
  .action(async (question: string, options: any) => {
    const opts = program.opts<GlobalOptions>();
    const { parseModelRef } = await loadCore();
    const runtime = await makeRuntime(opts, eventSink(opts));
    await runtime.start();
    try {
      const brief = await loadBriefOption(options.brief ?? opts.brief, opts);
      const metadata = compileBriefMetadata(brief, question, {
        workflow: "literature-review",
        dbs: options.db ? String(options.db).split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        limit: options.limit ? Number(options.limit) : undefined,
        maxReviewRounds: options.maxReviewRounds ? Number(options.maxReviewRounds) : undefined
      });
      const result = await runtime.run({
        input: question,
        agentId: "research-orchestrator",
        strategy: options.strategy,
        cwd: opts.cd ?? process.cwd(),
        model: parseModelRef(opts.model),
        packIds: ["literature"],
        metadata
      });
      printRunResult(result, opts);
    } finally {
      await runtime.stop();
    }
  });

async function runExec(prompt: string, options: any): Promise<void> {
  const opts = program.opts<GlobalOptions>();
  const { parseModelRef } = await loadCore();
  const runtime = await makeRuntime(opts, eventSink(opts));
  await runtime.start();
  try {
    const brief = await loadBriefOption(options.brief ?? opts.brief, opts);
    const result = await runtime.run({
      input: prompt,
      strategy: options.strategy ?? opts.strategy ?? "auto",
      model: parseModelRef(opts.model),
      cwd: opts.cd ?? process.cwd(),
      metadata: compileBriefMetadata(brief, prompt, {
        maxRetries: Number(options.maxRetries ?? 0) || undefined,
        maxReviewRounds: Number(options.maxReviewRounds ?? 0) || undefined
      })
    });
    printRunResult(result, opts);
  } finally {
    await runtime.stop();
  }
}

async function runInteractive(): Promise<void> {
  const opts = program.opts<GlobalOptions>();
  const { parseModelRef } = await loadCore();
  const runtime = await makeRuntime(opts, eventSink(opts));
  await runtime.start();
  const rl = createInterface({ input, output, prompt: "jiuwen-sci> " });
  let lastSessionId: string | undefined;
  const state: InteractiveState = {
    brief: await loadBriefOption(opts.brief, opts)
  };
  try {
    if (!opts.quiet) printInteractiveHelp();
    if (state.brief && !opts.quiet) console.log(`Loaded brief: ${state.brief.topic ?? "untitled"}`);
    rl.prompt();
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) {
        rl.prompt();
        continue;
      }
      try {
        if (line.startsWith("/")) {
          const shouldExit = await handleSlashCommand(line, runtime, opts, () => lastSessionId, state);
          if (shouldExit) break;
        } else {
          const result = await runtime.run({
            input: line,
            strategy: opts.strategy ?? "auto",
            model: parseModelRef(opts.model),
            cwd: opts.cd ?? process.cwd(),
            metadata: compileBriefMetadata(state.brief, line)
          });
          lastSessionId = result.sessionId;
          printRunResult(result, opts);
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
      rl.prompt();
    }
  } finally {
    rl.close();
    await runtime.stop();
  }
}

async function makeRuntime(opts: GlobalOptions, sink?: (event: RuntimeEvent) => void) {
  const { createRuntimeHost } = await loadCore();
  const { literaturePack } = await import("@jiuwen-sci/literature-pack");
  const runtime = await createRuntimeHost({ cwd: opts.cd ?? process.cwd(), model: opts.model, eventSink: sink });
  runtime.registerPack(literaturePack);
  return runtime;
}

async function withStartedRuntime(fn: (runtime: Awaited<ReturnType<typeof makeRuntime>>, opts: GlobalOptions) => Promise<void>): Promise<void> {
  const opts = program.opts<GlobalOptions>();
  const runtime = await makeRuntime(opts);
  await runtime.start();
  try {
    await fn(runtime, opts);
  } finally {
    await runtime.stop();
  }
}

function eventSink(opts: GlobalOptions): (event: RuntimeEvent) => void {
  const logPath = path.join(path.resolve(opts.cd ?? process.cwd()), ".jiuwen-sci", "logs", "events.jsonl");
  mkdirSync(path.dirname(logPath), { recursive: true });
  return (event) => {
    appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
    if (opts.quiet) return;
    if (opts.json) {
      console.log(JSON.stringify(event));
      return;
    }
    const line = formatEventLine(event, opts.verbose === true);
    if (line) console.log(line);
  };
}

function formatEventLine(event: RuntimeEvent, verbose: boolean): string | null {
  const session = String(event.sessionId ?? event.parentSessionId ?? "");
  const sessionSuffix = session ? ` [${session}]` : "";
  switch (event.type) {
    case "session.created":
      return `- Session started${sessionSuffix}`;
    case "pack.workflow.selected":
      return `- Workflow selected: ${event.workflowId}${event.packId ? ` (pack ${event.packId})` : ""}${event.reason ? ` - ${event.reason}` : ""}`;
    case "strategy.selected":
      return `- Strategy selected: ${event.strategy}${sessionSuffix}`;
    case "stage.started":
      return `- Stage started: ${event.stageId}${event.agentId ? ` via ${event.agentId}` : ""}${sessionSuffix}`;
    case "stage.completed":
      return `- Stage completed: ${event.stageId}${event.attempt ? ` attempt ${event.attempt}` : ""}${sessionSuffix}`;
    case "stage.redirected":
      return `- Stage redirected: ${event.stageId} -> ${event.nextStageId}${sessionSuffix}`;
    case "stage.failed":
      return `- Stage failed: ${event.stageId}${event.attempt ? ` attempt ${event.attempt}` : ""}${event.action ? ` (${event.action})` : ""}${sessionSuffix}`;
    case "task.started":
      return `- Subagent started: ${event.agentId}${event.childSessionId ? ` (${event.childSessionId})` : ""}${event.parentSessionId ? ` [parent ${event.parentSessionId}]` : ""}`;
    case "task.completed":
      return `- Subagent completed${event.childSessionId ? `: ${event.childSessionId}` : ""}${event.parentSessionId ? ` [parent ${event.parentSessionId}]` : ""}`;
    case "task.failed":
      return `- Subagent failed: ${event.agentId}${event.childSessionId ? ` (${event.childSessionId})` : ""}${event.error ? ` - ${event.error}` : ""}`;
    case "literature.search.started":
      return `- Search started: ${event.db} query=${formatInline(event.query)}${event.limit ? ` limit=${event.limit}` : ""}${sessionSuffix}`;
    case "literature.search.completed":
      return `- Search completed: ${event.db} ${event.count ?? 0} results${formatPaperTitles(event.papers)}${sessionSuffix}`;
    case "literature.search.failed":
      return `- Search failed: ${event.db} query=${formatInline(event.query)}${event.error ? ` - ${event.error}` : ""}${sessionSuffix}`;
    case "tool.started":
      return verbose ? `- Tool started: ${event.toolId}${event.agentId ? ` by ${event.agentId}` : ""}${sessionSuffix}` : null;
    case "tool.completed":
      return verbose ? `- Tool completed: ${event.toolId}${event.agentId ? ` by ${event.agentId}` : ""}${sessionSuffix}` : null;
    default:
      if (!verbose) return null;
      return `- ${event.type}${sessionSuffix}`;
  }
}

function formatInline(value: unknown): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return JSON.stringify(text.length > 180 ? `${text.slice(0, 180)}...` : text);
}

function formatPaperTitles(value: unknown): string {
  if (!Array.isArray(value) || !value.length) return "";
  const titles = value.map((paper: any) => paper?.title).filter(Boolean).slice(0, 3);
  if (!titles.length) return "";
  return `; top: ${titles.map((title) => String(title).replace(/\s+/g, " ").trim()).join(" | ")}`;
}

function printRunResult(result: RuntimeRunResult, opts: GlobalOptions): void {
  if (opts.json) {
    console.log(JSON.stringify({ type: "result", ...result }));
    return;
  }
  if (!opts.quiet) {
    console.log(`Completed: ${result.status}`);
    console.log(`Session: ${result.sessionId}`);
    if (result.artifactIds.length) console.log(`Artifacts: ${result.artifactIds.join(", ")}`);
  }
  console.log(result.output);
}

function print(value: unknown, opts: GlobalOptions): void {
  if (opts.json || typeof value !== "string") console.log(JSON.stringify(value, null, 2));
  else console.log(value);
}

function ensureExperimentalSqlite(): void {
  if (process.execArgv.includes("--experimental-sqlite") || process.env.JIUWEN_SCI_SQLITE_REEXEC === "1") return;
  const result = spawnSync(process.execPath, ["--experimental-sqlite", ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, JIUWEN_SCI_SQLITE_REEXEC: "1" }
  });
  process.exit(result.status ?? 1);
}

async function loadCore() {
  return import("@jiuwen-sci/core");
}

async function handleSlashCommand(line: string, runtime: Awaited<ReturnType<typeof makeRuntime>>, opts: GlobalOptions, lastSessionId: () => string | undefined, state: InteractiveState): Promise<boolean> {
  const [command = "", ...args] = line.slice(1).split(/\s+/).filter(Boolean);
  switch (command) {
    case "exit":
    case "quit":
      return true;
    case "help":
      printInteractiveHelp();
      return false;
    case "model":
      print({ configured: opts.model ?? null, default: runtime.services.config.defaultModel }, opts);
      return false;
    case "packs":
      print(runtime.services.packRegistry.list().map((p: any) => ({ id: p.id, name: p.name, version: p.version })), opts);
      return false;
    case "brief":
      await handleBriefCommand(args, state, opts);
      return false;
    case "status": {
      const id = lastSessionId();
      print({ cwd: runtime.services.config.cwd, database: runtime.services.config.paths.database, defaultModel: runtime.services.config.defaultModel, lastSessionId: id ?? null }, opts);
      return false;
    }
    case "sessions": {
      const limit = Number(args[0] ?? 10);
      const rows = await runtime.services.sessionStore.list(Number.isFinite(limit) ? limit : 10);
      print(rows.map((s: any) => ({ id: s.id, parentId: s.parentId, agentId: s.agentId, status: s.status, title: s.title, createdAt: s.createdAt })), opts);
      return false;
    }
    case "session": {
      const id = args[0] ?? lastSessionId();
      if (!id) console.log("No session id. Run a task first or pass /session <id>.");
      else print(await runtime.services.sessionStore.get(id), opts);
      return false;
    }
    case "tree": {
      const id = args[0] ?? lastSessionId();
      if (!id) {
        console.log("No session id. Run a task first or pass /tree <id>.");
        return false;
      }
      print(await sessionTree(runtime, id), opts);
      return false;
    }
    case "artifacts": {
      const id = args[0] === "last" ? lastSessionId() : args[0] ?? lastSessionId();
      if (!id) {
        console.log("No session id. Run a task first or pass /artifacts <session-id>.");
        return false;
      }
      const rows = await runtime.services.artifactStore.listBySession(id);
      print(rows.map((a: any) => ({ id: a.id, sessionId: a.sessionId, type: a.type, mediaType: a.mediaType, size: a.size, createdAt: a.createdAt })), opts);
      return false;
    }
    case "artifact": {
      const id = args[0];
      if (!id) console.log("Usage: /artifact <artifact-id>");
      else process.stdout.write((await runtime.services.artifactStore.read(id)).toString("utf8") + "\n");
      return false;
    }
    case "review": {
      const id = args[0] ?? lastSessionId();
      if (!id) console.log("No session id. Run a task first or pass /review <session-id>.");
      else print(await runtime.services.reviewStore.listBySession(id), opts);
      return false;
    }
    default:
      console.log(`Unknown command: /${command}. Use /help for commands.`);
      return false;
  }
}

async function sessionTree(runtime: Awaited<ReturnType<typeof makeRuntime>>, rootId: string): Promise<string> {
  const root = await runtime.services.sessionStore.get(rootId);
  if (!root) return `Session not found: ${rootId}`;
  const lines: string[] = [];
  async function walk(sessionId: string, indent: string): Promise<void> {
    const s = await runtime.services.sessionStore.get(sessionId);
    if (!s) return;
    lines.push(`${indent}${s.id} ${s.agentId} ${s.status} ${s.title}`);
    for (const child of await runtime.services.sessionStore.children(sessionId)) await walk(child.id, `${indent}  `);
  }
  await walk(root.id, "");
  return lines.join("\n");
}

async function handleBriefCommand(args: string[], state: InteractiveState, opts: GlobalOptions): Promise<void> {
  const action = args[0] ?? "show";
  if (action === "show") {
    if (!state.brief) console.log("No research brief loaded.");
    else console.log(formatBrief(state.brief));
    return;
  }
  if (action === "load") {
    const file = args[1];
    if (!file) {
      console.log("Usage: /brief load <file>");
      return;
    }
    state.brief = await readResearchBrief(resolveUserPath(file, opts));
    console.log(`Loaded brief: ${state.brief.topic ?? "untitled"}`);
    return;
  }
  if (action === "clear") {
    state.brief = undefined;
    console.log("Cleared research brief.");
    return;
  }
  if (action === "save") {
    const file = args[1];
    if (!file) {
      console.log("Usage: /brief save <file>");
      return;
    }
    if (!state.brief) {
      console.log("No research brief loaded.");
      return;
    }
    await writeFile(resolveUserPath(file, opts), formatBrief(state.brief));
    console.log(`Saved brief: ${file}`);
    return;
  }
  if (action === "new" || action === "draft") {
    const text = args.slice(1).join(" ").trim();
    if (!text) {
      console.log(`Usage: /brief ${action} <topic or requirements>`);
      return;
    }
    state.brief = draftResearchBrief(text);
    console.log(formatBrief(state.brief));
    return;
  }
  console.log("Usage: /brief [show|load <file>|save <file>|clear|new <topic>|draft <requirements>]");
}

async function loadBriefOption(file: string | undefined, opts: GlobalOptions): Promise<ResearchBrief | undefined> {
  if (!file) return undefined;
  return readResearchBrief(resolveUserPath(file, opts));
}

async function readResearchBrief(file: string): Promise<ResearchBrief> {
  const text = await readFile(file, "utf8");
  const trimmed = text.trim();
  const parsed = trimmed.startsWith("{") ? JSON.parse(trimmed) : parseBriefYaml(trimmed);
  return normalizeBrief(parsed);
}

function compileBriefMetadata(brief: ResearchBrief | undefined, prompt: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ...overrides };
  if (!brief) {
    if (!metadata.dbs && metadata.workflow === "literature-review") metadata.dbs = ["openalex"];
    if (!metadata.limit && metadata.workflow === "literature-review") metadata.limit = 25;
    if (!metadata.maxReviewRounds && metadata.workflow === "literature-review") metadata.maxReviewRounds = 2;
    return compactMetadata(metadata);
  }
  const topic = brief.topic ?? prompt;
  const include = brief.scope?.include ?? [];
  const domains = brief.focus?.domains ?? [];
  const questions = brief.focus?.questions ?? [];
  const institutions = brief.focus?.institutions ?? [];
  const geographies = brief.focus?.geographies ?? [];
  metadata.researchBrief = brief;
  metadata.topicProfile = {
    topicLabel: topic,
    coreTerms: uniqueStrings([topic, ...include, ...questions]),
    domainTerms: uniqueStrings([...domains, ...institutions, ...geographies]),
    modifierTerms: uniqueStrings(["development status", "current status", "trend", "trends", "future directions", "review", "survey", "现状", "趋势", "发展"])
  };
  metadata.sourcePreferences = {
    preferredSources: brief.sources?.preferred_sources ?? [],
    excludedSources: brief.sources?.exclude_sources ?? [],
    dateRange: brief.sources?.date_range,
    institutions,
    geographies
  };
  metadata.evidencePreferences = brief.evidence ?? {};
  metadata.outputPreferences = brief.output ?? {};
  metadata.inclusionCriteria = brief.scope?.include ?? [];
  metadata.exclusionCriteria = brief.scope?.exclude ?? [];
  if (!metadata.dbs && brief.sources?.databases?.length) metadata.dbs = brief.sources.databases;
  if (!metadata.limit && brief.output?.max_papers) metadata.limit = brief.output.max_papers;
  if (!metadata.workflow && (brief.intent === "literature_review" || /literature|review|survey|文献|调研|综述/.test(`${brief.intent ?? ""} ${prompt}`.toLowerCase()))) metadata.workflow = "literature-review";
  if (!metadata.dbs && metadata.workflow === "literature-review") metadata.dbs = ["openalex"];
  if (!metadata.limit && metadata.workflow === "literature-review") metadata.limit = 25;
  if (!metadata.maxReviewRounds && metadata.workflow === "literature-review") metadata.maxReviewRounds = 2;
  return compactMetadata(metadata);
}

function draftResearchBrief(text: string): ResearchBrief {
  return {
    topic: text,
    intent: "literature_review",
    scope: { include: extractBriefTerms(text), exclude: [] },
    focus: { questions: [text], domains: [], institutions: extractInstitutions(text), geographies: [] },
    sources: { databases: ["openalex", "arxiv", "semantic-scholar", "crossref"], preferred_sources: [], exclude_sources: [], date_range: extractDateRange(text) },
    evidence: { study_types: ["review", "survey", "benchmark", "empirical study"], require_abstract: true },
    output: { language: /[一-龥]/.test(text) ? "zh" : "en", format: "report", depth: "standard", max_papers: 25, include: ["PRISMA flow", "evidence table", "citation list", "gaps and trends"] },
    notes: []
  };
}

function normalizeBrief(value: any): ResearchBrief {
  return {
    topic: stringValue(value.topic),
    intent: stringValue(value.intent),
    scope: value.scope ? { include: stringArray(value.scope.include), exclude: stringArray(value.scope.exclude) } : undefined,
    focus: value.focus ? { questions: stringArray(value.focus.questions), domains: stringArray(value.focus.domains), institutions: stringArray(value.focus.institutions), geographies: stringArray(value.focus.geographies) } : undefined,
    sources: value.sources ? { databases: stringArray(value.sources.databases), preferred_sources: stringArray(value.sources.preferred_sources), exclude_sources: stringArray(value.sources.exclude_sources), date_range: value.sources.date_range } : undefined,
    evidence: value.evidence,
    output: value.output ? { ...value.output, max_papers: numberValue(value.output.max_papers) } : undefined,
    notes: stringArray(value.notes)
  };
}

function parseBriefYaml(text: string): any {
  const root: any = {};
  const stack: { indent: number; value: any }[] = [{ indent: -1, value: root }];
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const line = rawLine.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].value;
    if (line.startsWith("- ")) {
      if (!Array.isArray(parent)) continue;
      parent.push(parseScalar(line.slice(2)));
      continue;
    }
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const rest = line.slice(idx + 1).trim();
    if (rest) {
      parent[key] = parseScalar(rest);
      continue;
    }
    const nextContainer = nextMeaningfulLineIsArray(text, rawLine) ? [] : {};
    parent[key] = nextContainer;
    stack.push({ indent, value: nextContainer });
  }
  return root;
}

function nextMeaningfulLineIsArray(text: string, currentLine: string): boolean {
  const lines = text.split(/\r?\n/);
  const index = lines.indexOf(currentLine);
  const currentIndent = currentLine.match(/^ */)?.[0].length ?? 0;
  for (const line of lines.slice(index + 1)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.match(/^ */)?.[0].length ?? 0;
    return indent > currentIndent && line.trim().startsWith("- ");
  }
  return false;
}

function parseScalar(value: string): unknown {
  const unquoted = value.replace(/^["']|["']$/g, "");
  if (unquoted === "true") return true;
  if (unquoted === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(unquoted)) return Number(unquoted);
  return unquoted;
}

function formatBrief(brief: ResearchBrief): string {
  return yamlStringify(normalizeBrief(brief)).trimEnd() + "\n";
}

function yamlStringify(value: any, indent = 0): string {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) return value.map((item) => `${pad}- ${formatScalar(item)}\n`).join("");
  if (!value || typeof value !== "object") return `${pad}${formatScalar(value)}\n`;
  return Object.entries(value)
    .filter(([, child]) => child !== undefined && !(Array.isArray(child) && child.length === 0))
    .map(([key, child]) => {
      if (Array.isArray(child)) return `${pad}${key}:\n${yamlStringify(child, indent + 2)}`;
      if (child && typeof child === "object") return `${pad}${key}:\n${yamlStringify(child, indent + 2)}`;
      return `${pad}${key}: ${formatScalar(child)}\n`;
    })
    .join("");
}

function formatScalar(value: unknown): string {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return String(value ?? "").replace(/\n/g, " ");
}

function resolveUserPath(file: string, opts: GlobalOptions): string {
  return path.resolve(opts.cd ?? process.cwd(), file);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((item) => item.trim()).filter(Boolean);
}

function numberValue(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function compactMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
}

function extractBriefTerms(text: string): string[] {
  const quoted = [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const acronyms = [...text.matchAll(/\b[A-Z][A-Z0-9]{2,}\b/g)].map((match) => match[0]);
  return uniqueStrings([...quoted, ...acronyms, text]).slice(0, 6);
}

function extractInstitutions(text: string): string[] {
  const known = ["DeepMind", "OpenAI", "Stanford", "MIT", "Harvard", "清华", "北大", "中科院", "浙大", "上海交大"];
  return known.filter((name) => text.includes(name));
}

function extractDateRange(text: string): { from?: number; to?: number } | undefined {
  const years = [...text.matchAll(/\b(19|20)\d{2}\b/g)].map((match) => Number(match[0]));
  if (!years.length) return undefined;
  return { from: Math.min(...years), to: Math.max(...years) };
}

function printInteractiveHelp(): void {
  console.log("jiuwen-sci interactive mode");
  console.log("Type a research goal and press Enter. The orchestrator will select registered packs when useful.");
  console.log("Commands: /help /status /model /packs /brief /sessions [n] /session [id] /tree [id] /artifacts [id|last] /artifact <id> /review [id] /exit");
}

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
