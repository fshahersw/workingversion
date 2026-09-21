import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { AgentSkill } from "../../writer/packages/agent-core/src/index.ts";
import type { DeckAccess } from "../../office/slides/src/renderer/ai/slides-skill.ts";
import type { RenderSlide } from "../../writer/packages/pptx-render/src/render-tree.ts";

// Bundle the real renderer skill and its operation guides. Only UI translation
// is replaced: the preflight, transaction dispatch, and result handling are real.
const modulePromise = (async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const bundled = await build({
    absWorkingDir: root,
    stdin: { contents: 'export { createSlidesSkill } from "./src/office/slides/src/renderer/ai/slides-skill.ts"; export { createCompanionSkill } from "./src/office/slides/src/renderer/ai/sw-skill.ts";', resolveDir: root, loader: 'ts' },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "es2022",
    plugins: [{
      name: "slides-test-browser-resources",
      setup(builder) {
        builder.onResolve({ filter: /\?raw$/ }, args => ({
          path: path.resolve(args.resolveDir, args.path.slice(0, -4)),
          namespace: "raw-guide",
        }));
        builder.onLoad({ filter: /.*/, namespace: "raw-guide" }, async args => ({
          contents: await readFile(args.path, "utf8"),
          loader: "text",
        }));
        builder.onResolve({ filter: /^\.\.\/i18n\/locale$/ }, () => ({
          path: "locale",
          namespace: "ui-translation",
        }));
        builder.onLoad({ filter: /.*/, namespace: "ui-translation" }, () => ({
          contents: "export const t = key => key;",
          loader: "js",
        }));
      },
    }],
  });
  const code = bundled.outputFiles[0]?.text;
  assert.ok(code, "the actual Slides skill must bundle");
  return await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`) as {
    createSlidesSkill(access: DeckAccess): AgentSkill;
    createCompanionSkill(base: AgentSkill, getMode: () => "ask" | "review" | "write"): AgentSkill;
  };
})();

function blankSlide(): RenderSlide {
  return { widthPx: 1280, heightPx: 720, scale: 1, background: { kind: "solid", color: "#FFFFFF" }, nodes: [] };
}

function deckAccess() {
  const original = [blankSlide()];
  let slides = original;
  const replacements: Array<{ slides: RenderSlide[]; goTo?: number }> = [];
  const access: DeckAccess = {
    getSlides: () => slides,
    getCurrent: () => 0,
    getSelectedIds: () => [],
    fitWidthPx: 1280,
    gskTools: () => false,
    applySlide: () => assert.fail("apply_ops must apply its atomic deck result"),
    applyDeck: (next, goTo) => { replacements.push({ slides: next, goTo }); slides = next; },
  };
  return { access, original, replacements };
}

async function withNativeTransaction<T>(applyTxn: (request: unknown) => Promise<unknown>, run: () => Promise<T>): Promise<T> {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = Object.getOwnPropertyDescriptor(globals, "window");
  Object.defineProperty(globals, "window", { value: { slidesApi: { applyTxn } }, configurable: true, writable: true });
  try {
    return await run();
  } finally {
    if (previous) Object.defineProperty(globals, "window", previous);
    else delete globals.window;
  }
}

test("actual Slides apply_ops preserves an exact textbox insert on an existing blank slide", async () => {
  const { createSlidesSkill } = await modulePromise;
  const fixture = deckAccess();
  const skill = createSlidesSkill(fixture.access);
  const input = {
    ops: [{
      op: "addElement",
      target: { slide: 0 },
      kind: "textbox",
      offset: { x: 914400, y: 685800, cx: 7315200, cy: 914400 },
      paragraphs: [{ runs: [{ text: "Exact requested text.", bold: true, fontSize: 24, color: "#172E4C" }], align: "left" }],
    }],
  };
  const before = structuredClone(input);
  const nativeRequests: unknown[] = [];
  const nativeSlides = [blankSlide()];
  const result = await withNativeTransaction(async request => {
    nativeRequests.push(structuredClone(request));
    return { applied: true, slides: nativeSlides, records: [{ op: "addElement", target: "0", created: ["e_inserted"] }] };
  }, async () => await skill.executeTool({ id: "insert-text", name: "apply_ops", input }));

  assert.deepEqual(nativeRequests, [before], "one bounded insert must reach the native engine without a cloud-generation detour or restyling");
  assert.deepEqual(input, before, "the requested text, 24pt font, navy color, and exact EMU frame must remain unchanged");
  assert.equal(result.isError, undefined);
  assert.equal(result.mutated, true);
  assert.match(result.output, /e_inserted/);
  assert.deepEqual(fixture.replacements, [{ slides: nativeSlides, goTo: 0 }]);
});

test("new native operation schemas dispatch unchanged and mode changes revoke write access", async () => {
  const { createSlidesSkill, createCompanionSkill } = await modulePromise;
  let mode: "ask" | "review" | "write" = "write";
  const skill = createCompanionSkill(createSlidesSkill(deckAccess().access), () => mode);
  const tool = skill.tools.find(value => value.name === "apply_ops")!;
  const schema = tool.inputSchema as any;
  assert.equal(schema.properties.ops.maxItems, 50, "browser limit must match the native transaction boundary");
  const operations = ['addAnimation','addConnector','addSlideWithLayout','alignElements','distributeElements','insertEquation','removeAnimation','reorderAnimation','setShapeCustomGeometry','setSlideLayout','setTableStyle'];
  for (const op of operations) assert.ok(schema.properties.ops.items.properties.op.enum.includes(op), op);
  const requests: unknown[] = [];
  const call = { id: "layout-ops", name: "apply_ops", input: {ops:[{op:"alignElements",target:{slide:0},els:["e_one","e_two"],mode:"left"}]}};
  await withNativeTransaction(async request => { requests.push(request); return {applied:true,slides:[blankSlide()],records:[{op:"alignElements",target:"0"}]}; }, async () => {
    assert.equal((await skill.executeTool(call)).mutated,true);
    for (mode of ["ask", "review"] as const) {
      assert.ok(!skill.tools.some(value => value.name === "apply_ops"));
      assert.equal((await skill.executeTool(call)).isError,true);
      assert.ok(skill.tools.some(value => value.name === "read_slide"));
    }
  });
  assert.deepEqual(requests,[call.input]);
});

test("read_slide returns actual native identities read-only and never invents an unavailable inventory", async () => {
  const { createSlidesSkill } = await modulePromise;
  const skill=createSlidesSkill(deckAccess().access);
  const global=globalThis as unknown as Record<string,unknown>;
  const previous=Object.getOwnPropertyDescriptor(global,"window");
  const native={animations:[{seq:0,el:null},{seq:1,el:"e_shape"}],layoutCount:1,layouts:[{index:0,path:"ppt/slideLayouts/slideLayout1.xml",name:"Blank"}]};
  let reads=0;
  Object.defineProperty(global,"window",{value:{slidesApi:{readNativeDetails:async(index:number)=>{assert.equal(index,0);reads++;return native;}}},configurable:true,writable:true});
  try {
    const result=await skill.executeTool({id:"native-read",name:"read_slide",input:{slideIndex:0,include_native:true}});
    assert.equal(result.mutated,false); assert.match(result.output,/"seq":0,"el":null/); assert.match(result.output,/untrusted-native-slide-data/); assert.equal(reads,1);
    (global.window as any).slidesApi.readNativeDetails=undefined;
    assert.equal((await skill.executeTool({id:"missing-read",name:"read_slide",input:{slideIndex:0,include_native:true}})).isError,true);
  } finally { if(previous)Object.defineProperty(global,"window",previous);else delete global.window; }
});

test("new style operation rejects raw model XML and oversized batches before native dispatch", async () => {
  const { createSlidesSkill }=await modulePromise;
  const skill=createSlidesSkill(deckAccess().access);
  await withNativeTransaction(async()=>assert.fail("invalid inputs must not reach the engine"),async()=>{
    for(const input of [{ops:[{op:"setTableStyle",target:{slide:0,el:"e_table"},edit:{tblPrXml:"<untrusted/>"}}]},{ops:Array.from({length:51},()=>({op:"addAnimation",target:{slide:0,el:"e_a"},effect:"fade"}))}]) {
      const result=await skill.executeTool({id:"invalid-style",name:"apply_ops",input});
      assert.equal(result.isError,true); assert.equal(result.mutated,false);
    }
  });
});

test("Slides advertises the canonical operation envelope and editable textbox signature", async () => {
  const { createSlidesSkill } = await modulePromise;
  const skill = createSlidesSkill(deckAccess().access);
  const tool = skill.tools.find(value => value.name === "apply_ops");
  assert.ok(tool);
  const schema = tool.inputSchema as {
    properties: { ops: { items: {
      required?: string[];
      properties?: { op?: { enum?: string[] }; target?: { required?: string[] } };
    } } };
  };
  const item = schema.properties.ops.items;
  assert.ok(item.required?.includes("op"), "the provider must receive the actual operation name field");
  assert.ok(item.properties?.op?.enum?.includes("addElement"));
  assert.ok(!item.properties?.op?.enum?.includes("insert-new-element"));
  assert.ok(item.properties?.target?.required?.includes("slide"), "a supplied target must identify its slide");
  assert.ok(!item.required?.includes("target"), "deck-wide operations must remain expressible without a slide target");
  assert.match(tool.description, /addElement[^\n]*kind:"textbox"/);
});

test("actual Slides skill leaves rejected unknown or missing native operations unapplied", async () => {
  const { createSlidesSkill } = await modulePromise;
  for (const invalid of [
    { op: "insert-new-element", target: { slide: 0 } },
    { target: { slide: 0 } },
  ]) {
    const fixture = deckAccess();
    const skill = createSlidesSkill(fixture.access);
    const requests: unknown[] = [];
    const input = { ops: [invalid] };
    const result = await withNativeTransaction(async request => {
      requests.push(structuredClone(request));
      return { applied: false, failures: [{ index: 0, error: "Native validation rejected the operation name." }] };
    }, async () => await skill.executeTool({ id: "invalid-insert", name: "apply_ops", input }));
    assert.deepEqual(requests, [input], "native validation remains authoritative for malformed operation payloads");
    assert.equal(result.isError, true);
    assert.equal(result.mutated, false);
    assert.match(result.output, /Native validation rejected the operation name/);
    assert.equal(fixture.replacements.length, 0);
    assert.strictEqual(fixture.access.getSlides(), fixture.original);
  }
});
