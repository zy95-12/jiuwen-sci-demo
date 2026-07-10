#!/usr/bin/env node
import { Command } from "commander";
import {
  createRuntimeHost,
  parseModelRef,
  RuntimeEvent,
  RuntimeRunResult
} from "@jiuwen-sci/core";
import { literaturePack } from "@jiuwen-sci/literature-pack";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

type GlobalOptions = {
  cd?: string;
  model?: string;
  config?: string[];
  approval?: string;
  sandbox?: string;
  strategy?: string;
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
};

const program = new Command();

program
  .name("jiuwen-sci")
  .description("CLI-first scientific Agent Runtime")
  .version("0.1.0")
  .option("-C, --cd <path>", "set working directory")
  .option("-m, --model <provider:model>", "model to use")
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
  printInteractiveHelp();
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
    runtime.registerPack(literaturePack);
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
    runtime.registerPack(literaturePack);
    print(runtime.services.packRegistry.list().map((p) => ({ id: p.id, name: p.name, version: p.version })), opts);
  });
});

const literature = program.command("literature").description("literature research workflows");
literature.command("review")
  .description("run a literature review workflow")
  .argument("<question>", "research question")
  .option("--db <ids>", "comma separated db ids")
  .option("--limit <n>", "result limit", "25")
  .option("--strategy <strategy>", "execution strategy", "workflow_controlled")
  .option("--max-review-rounds <n>", "maximum review rounds", "2")
  .action(async (question: string, options: any) => {
    const opts = program.opts<GlobalOptions>();
    const runtime = await makeRuntime(opts, eventSink(opts));
    await runtime.start();
    runtime.registerPack(literaturePack);
    try {
      const result = await runtime.run({
        input: question,
        agentId: "research-orchestrator",
        strategy: options.strategy,
        cwd: opts.cd ?? process.cwd(),
        model: parseModelRef(opts.model),
        packIds: ["literature"],
        metadata: {
          workflow: "literature-review",
          dbs: options.db ? String(options.db).split(",").map((s) => s.trim()).filter(Boolean) : ["openalex"],
          limit: Number(options.limit),
          maxReviewRounds: Number(options.maxReviewRounds)
        }
      });
      printRunResult(result, opts);
    } finally {
      await runtime.stop();
    }
  });

async function runExec(prompt: string, options: any): Promise<void> {
  const opts = program.opts<GlobalOptions>();
  const runtime = await makeRuntime(opts, eventSink(opts));
  await runtime.start();
  try {
    const result = await runtime.run({
      input: prompt,
      strategy: options.strategy ?? opts.strategy ?? "auto",
      model: parseModelRef(opts.model),
      cwd: opts.cd ?? process.cwd(),
      metadata: {
        maxRetries: Number(options.maxRetries ?? 0) || undefined,
        maxReviewRounds: Number(options.maxReviewRounds ?? 0) || undefined
      }
    });
    printRunResult(result, opts);
  } finally {
    await runtime.stop();
  }
}

async function makeRuntime(opts: GlobalOptions, sink?: (event: RuntimeEvent) => void) {
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
  return (event) => {
    if (opts.quiet) return;
    if (opts.json) {
      console.log(JSON.stringify(event));
      return;
    }
    if (opts.verbose || ["session.created", "strategy.selected", "tool.completed", "task.started", "task.completed"].includes(event.type)) {
      console.log(`- ${event.type}${event.sessionId ? ` ${event.sessionId}` : ""}${event.toolId ? ` ${event.toolId}` : ""}${event.strategy ? ` ${event.strategy}` : ""}`);
    }
  };
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

function printInteractiveHelp(): void {
  console.log("jiuwen-sci interactive mode v0");
  console.log("Use `jiuwen-sci exec \"prompt\"` or `jiuwen-sci literature review \"question\"`.");
  console.log("Slash commands reserved for v0: /init /status /model /agent /strategy /permissions /tasks /artifacts /provenance /review /compact /exit");
}

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
