import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'foundry'

// 只要 apply 里用了 ctx.tools / ctx.webServer 就必须声明 inject(标准 Cordis 硬依赖)
export const inject = ['tools', 'webServer']

// ============================================================
// Plugin Foundry — a self-extending, everything-is-a-plugin compiler
//
//  1. ctx.provide('foundry', service) —— 其它插件可用 ctx.get('foundry')
//     .registerBlueprint(...) 注册新"配方",实现"插件扩展插件、插件造插件"。
//  2. foundry_blueprints / foundry_scaffold / foundry_validate —— 三个模型
//     工具,把参数编译成可直接 cordis_define 的动态插件代码,并静态校验。
//  3. /foundry/state —— 给 Client 半的设置页提供蓝图目录。
// ============================================================

function q(v) {
  return JSON.stringify(String(v == null ? '' : v))
}

function serializeBlueprint(bp) {
  return {
    id: bp.id,
    name: bp.name || bp.id,
    category: bp.category || 'general',
    description: bp.description || '',
    whenToUse: bp.whenToUse || '',
    params: (bp.params || []).map(function (p) {
      return {
        name: p.name,
        label: p.label || p.name,
        type: p.type || 'string',
        required: !!p.required,
        default: p.default != null ? p.default : null,
        placeholder: p.placeholder || '',
      }
    }),
  }
}

function validateCode(code) {
  const src = String(code || '')
  const errors = []
  const warnings = []
  if (!src.trim()) {
    return { ok: false, errors: ['Empty code body.'], warnings: [], summary: 'Empty code body.' }
  }
  if (/\bimport\s+[\w{*"' ]/.test(src)) errors.push('ES module `import` is not allowed; write a plain JS function body.')
  if (/\brequire\s*\(/.test(src)) errors.push('`require()` is not allowed.')
  if (/\bexport\s+(default|const|let|var|function|class|\{)/.test(src)) errors.push('`export` is not allowed; return the Plugin object instead.')
  if (/\binterface\s+[A-Za-z_$]/.test(src)) errors.push('TypeScript `interface` is not allowed.')
  if (/\benum\s+[A-Za-z_$]/.test(src)) errors.push('TypeScript `enum` is not allowed.')
  if (/\btype\s+[A-Za-z_$]+\s*=/.test(src)) errors.push('TypeScript `type` alias is not allowed.')
  if (/\bimplements\s+[A-Za-z_$]/.test(src)) errors.push('TypeScript `implements` is not allowed.')
  if (/(^|[^A-Za-z0-9_$])as\s+[A-Z][A-Za-z0-9_$]*/.test(src)) errors.push('TypeScript `as` cast is not allowed.')
  if (/(^|[;\n])\s*@[A-Za-z_$][\w$]*/.test(src)) errors.push('Decorators are not allowed.')
  if (/\)\s*:\s*[A-Za-z_$][\w$<>[\]|&. ,]*\{/.test(src)) errors.push('Return type annotation looks like TypeScript; remove `: Type`.')
  if (/\b(const|let|var)\s+[A-Za-z_$][\w$]*\s*:\s*[A-Za-z_$]/.test(src)) errors.push('Variable type annotation looks like TypeScript; remove `: Type`.')
  if (/<\s*[A-Za-z][\w.-]*(\s|>|\/)/.test(src) || /<\//.test(src)) errors.push('JSX is not allowed; use React.createElement(...).')
  if (!/\breturn\s*\{/.test(src)) errors.push('The body must `return` a Plugin object.')
  if (!/\bapply\s*[:(]/.test(src)) errors.push('The returned Plugin object needs an `apply(ctx)` method.')

  const used = []
  const re = /ctx\.([A-Za-z_$][\w$]*)/g
  let m
  while ((m = re.exec(src)) !== null) {
    if (used.indexOf(m[1]) === -1) used.push(m[1])
  }
  const safe = ['get', 'on', 'provide', 'effect']
  const injectMatch = src.match(/inject\s*:\s*\[([^\]]*)\]/)
  const injected = injectMatch ? (injectMatch[1].match(/'[^']+'/g) || []).map(function (s) { return s.slice(1, -1) }) : []
  used.forEach(function (prop) {
    if (safe.indexOf(prop) !== -1) return
    if (injected.indexOf(prop) !== -1) return
    errors.push("Uses ctx." + prop + " without inject: ['" + prop + "']. Declare it in inject, or use ctx.get('" + prop + "') with an undefined check.")
  })

  if (/\bsetTimeout\s*\(|\bsetInterval\s*\(/.test(src)) warnings.push('Uses raw setTimeout/setInterval; prefer the `timer` service so it is disposed with the fiber.')
  if (/\bJSON\.stringify\s*\(|\bstructuredClone\s*\(/.test(src)) warnings.push('Serializing live DSH objects is unsafe; copy only the leaf fields you need.')
  if (/\bdocument\.|\bwindow\./.test(src)) warnings.push('References document/window; query Client Builtins before assuming these globals exist.')
  if (/\b(process|Buffer|globalThis|self)\s*\.|\beval\s*\(|\bnew\s+Function\s*\(/.test(src)) warnings.push('References a Node/worker global or dynamic code execution that is unavailable/unsafe in plugin bodies.')

  const ok = errors.length === 0
  const summary = ok
    ? 'Valid plugin body (' + warnings.length + ' warning' + (warnings.length === 1 ? '' : 's') + ').'
    : 'Found ' + errors.length + ' error' + (errors.length === 1 ? '' : 's') + ' and ' + warnings.length + ' warning' + (warnings.length === 1 ? '' : 's') + '.'
  return { ok, errors, warnings, summary }
}

function makeBlueprint(id, name, category, description, whenToUse, params, render) {
  return { id, name, category, description, whenToUse, params, render }
}

const BUILTIN_BLUEPRINTS = [
  makeBlueprint(
    'host-tool', 'Host Dynamic Tool', 'host',
    'A Host-only plugin that registers a new model-callable Tool.',
    'Use when you want to add a reusable capability callable by you and any subagent in later steps.',
    [
      { name: 'toolName', label: 'Tool name', type: 'string', required: true, default: 'my_tool', placeholder: 'snake_case tool name' },
      { name: 'toolDescription', label: 'Tool description', type: 'string', required: true, default: 'A dynamic tool.', placeholder: 'What the tool does' },
    ],
    function (p) {
      const name = String(p.toolName || 'my_tool')
      const desc = String(p.toolDescription || 'A dynamic tool.')
      return {
        host: 'return {\n' +
          '  apply(ctx) {\n' +
          '    harness.registerTool(ctx, harness.defineTool({\n' +
          '      name: ' + q(name) + ',\n' +
          '      description: ' + q(desc) + ',\n' +
          '      parameters: {\n' +
          '        type: "object",\n' +
          '        properties: { input: { type: "string", description: "Input text" } },\n' +
          '        required: ["input"],\n' +
          '      },\n' +
          '      output: {\n' +
          '        schema: { type: "json" },\n' +
          '        render: function (args, value) { return [{ type: "text", text: JSON.stringify(value) }]; },\n' +
          '      },\n' +
          '      execute: async (args) => {\n' +
          '        const input = String(args && args.input || "");\n' +
          '        return { echo: input, length: input.length, tool: ' + q(name) + ' };\n' +
          '      },\n' +
          '    }));\n' +
          '  },\n' +
          '}',
        client: null,
        notes: [
          'Host-only plugin: registers a model-callable Tool named ' + name + '.',
          'Paste this into cordis_define `code.host`, then cordis_run.',
          'The Tool becomes callable by you and subagents in the next model step.',
        ],
      }
    }
  ),
  makeBlueprint(
    'client-panel', 'Client Slot Panel', 'client',
    'A Client-only plugin that injects a React panel into the cordis_run card.',
    'Use when you want a visible, interactive piece of UI beside the run card in the conversation.',
    [
      { name: 'title', label: 'Panel title', type: 'string', required: true, default: 'Hello Panel', placeholder: 'Heading text' },
      { name: 'message', label: 'Message', type: 'string', required: false, default: 'Built by Plugin Foundry.', placeholder: 'Body text' },
    ],
    function (p) {
      const title = String(p.title || 'Hello Panel')
      const message = String(p.message || '')
      return {
        host: null,
        client: 'function Panel(props) {\n' +
          '  return React.createElement("div", { style: { padding: "12px", border: "1px solid rgba(255,255,255,.15)", borderRadius: "10px" } },\n' +
          '    React.createElement("h4", null, ' + q(title) + '),\n' +
          '    React.createElement("p", null, ' + q(message) + '),\n' +
          '    React.createElement("p", { style: { opacity: 0.6, fontSize: "11px" } }, "Package " + props.packageId),\n' +
          '  );\n' +
          '}\n' +
          'return {\n' +
          '  apply(ctx) {\n' +
          '    const slots = ctx.get("slots");\n' +
          '    if (slots === undefined) return;\n' +
          '    slots.inject("tool.view.cordis", () => slots.register(\n' +
          '      { name: "tool.view.cordis", key: "self" },\n' +
          '      (props) => React.createElement(Panel, { packageId: props.packageId }),\n' +
          '    ));\n' +
          '  },\n' +
          '}',
        notes: [
          'Client-only plugin: injects a panel into the cordis_run card.',
          'Paste this into cordis_define `code.client`, then cordis_run.',
        ],
      }
    }
  ),
  makeBlueprint(
    'rpc-duo', 'Host + Client RPC', 'both',
    'A Host+Client plugin wired together through package-private JSON RPC.',
    'Use when the UI needs data or actions that only the Host process can produce.',
    [
      { name: 'methodName', label: 'RPC method', type: 'string', required: true, default: 'ping', placeholder: 'camelCase method name' },
      { name: 'label', label: 'Panel label', type: 'string', required: false, default: 'RPC Demo', placeholder: 'Heading text' },
    ],
    function (p) {
      const method = String(p.methodName || 'ping')
      const label = String(p.label || 'RPC Demo')
      return {
        host: 'return {\n' +
          '  apply(ctx) {\n' +
          '    harness.handle(' + q(method) + ', async (args) => {\n' +
          '      return { message: "Hello from Host", received: args || null };\n' +
          '    });\n' +
          '  },\n' +
          '}',
        client: 'function App() {\n' +
          '  const [result, setResult] = React.useState(null);\n' +
          '  React.useEffect(() => {\n' +
          '    host.call(' + q(method) + ', { ping: true }).then((r) => setResult(r)).catch((e) => setResult({ error: String(e) }));\n' +
          '  }, []);\n' +
          '  return React.createElement("div", { style: { padding: "12px" } },\n' +
          '    React.createElement("h4", null, ' + q(label) + '),\n' +
          '    React.createElement("pre", null, JSON.stringify(result)),\n' +
          '  );\n' +
          '}\n' +
          'return {\n' +
          '  apply(ctx) {\n' +
          '    const slots = ctx.get("slots");\n' +
          '    if (slots === undefined) return;\n' +
          '    slots.inject("tool.view.cordis", () => slots.register(\n' +
          '      { name: "tool.view.cordis", key: "self" },\n' +
          '      () => React.createElement(App),\n' +
          '    ));\n' +
          '  },\n' +
          '}',
        notes: [
          'Host registers `harness.handle("' + method + '")`, Client calls `host.call("' + method + '")`.',
          'Paste host into code.host and client into code.client, then cordis_run.',
        ],
      }
    }
  ),
  makeBlueprint(
    'event-observer', 'Event Observer', 'host',
    'A Host-only plugin that subscribes to a Host event and logs a tagged summary.',
    'Use to observe runtime lifecycle (e.g. tools/change, agent/status) without changing behavior.',
    [
      { name: 'eventName', label: 'Event name', type: 'string', required: true, default: 'tools/change', placeholder: 'e.g. tools/change' },
      { name: 'note', label: 'Log prefix', type: 'string', required: false, default: 'event', placeholder: 'Short tag' },
    ],
    function (p) {
      const evt = String(p.eventName || 'tools/change')
      const note = String(p.note || 'event')
      return {
        host: 'return {\n' +
          '  apply(ctx) {\n' +
          '    ctx.on(' + q(evt) + ', (payload) => {\n' +
          '      console.log(' + q(note) + ', payload);\n' +
          '    });\n' +
          '  },\n' +
          '}',
        client: null,
        notes: [
          'Host-only plugin: subscribes to Host event ' + evt + '.',
          'Logs are tagged with the package name; watch the Host console.',
          'The listener is auto-removed when the plugin stops.',
        ],
      }
    }
  ),
  makeBlueprint(
    'service-provider', 'Service Provider', 'host',
    'A Host-only plugin that publishes a new Service other plugins can consume via ctx.get().',
    'Use when you want to expose a small API surface to the rest of the runtime.',
    [
      { name: 'serviceName', label: 'Service name', type: 'string', required: true, default: 'my_service', placeholder: 'camelCase service key' },
      { name: 'about', label: 'Description', type: 'string', required: false, default: 'A service provided by a plugin.', placeholder: 'What it offers' },
    ],
    function (p) {
      const svc = String(p.serviceName || 'my_service')
      const about = String(p.about || 'A service provided by a plugin.')
      return {
        host: 'return {\n' +
          '  apply(ctx) {\n' +
          '    ctx.provide(' + q(svc) + ', {\n' +
          '      ping: () => "pong",\n' +
          '      about: ' + q(about) + ',\n' +
          '    });\n' +
          '  },\n' +
          '}',
        client: null,
        notes: [
          'Publishes service `' + svc + '`; other plugins read it with ctx.get("' + svc + '").',
          'The service is removed when this plugin stops.',
        ],
      }
    }
  ),
  makeBlueprint(
    'timer-beat', 'Timer Heartbeat', 'host',
    'A Host-only plugin that runs a periodic task via the timer service.',
    'Use for recurring background work that must be disposed cleanly with the plugin.',
    [
      { name: 'intervalMs', label: 'Interval (ms)', type: 'number', required: true, default: 5000, placeholder: '1000' },
      { name: 'label', label: 'Log tag', type: 'string', required: false, default: 'beat', placeholder: 'Short tag' },
    ],
    function (p) {
      let ms = parseInt(p.intervalMs, 10)
      if (!ms || ms < 1) ms = 5000
      const label = String(p.label || 'beat')
      return {
        host: 'return {\n' +
          '  inject: ["timer"],\n' +
          '  apply(ctx) {\n' +
          '    ctx.interval(() => {\n' +
          '      console.log(' + q(label) + ', Date.now());\n' +
          '    }, ' + ms + ');\n' +
          '  },\n' +
          '}',
        client: null,
        notes: [
          'Declares inject:["timer"] and uses ctx.interval, which is auto-disposed with the plugin.',
          'Never use raw setInterval; the timer service is fiber-scoped.',
        ],
      }
    }
  ),
  makeBlueprint(
    'system-prompt-section', 'System Prompt Section', 'host',
    "Injects a persistent, ordered section into the agent's own system prompt, assembled before every model step.",
    "Use when a generated plugin should permanently teach or steer the agent's behavior from inside its prompt.",
    [
      { name: 'sectionName', label: 'Section name (unique)', type: 'string', required: true, default: 'foundry-rule', placeholder: 'unique name' },
      { name: 'sectionOrder', label: 'Order', type: 'number', required: true, default: 100, placeholder: '-100 identity, 0 persona, 100-199 tool guidance' },
      { name: 'sectionText', label: 'Section text', type: 'string', required: true, default: 'Follow the Plugin Foundry contract: plugin bodies are plain JS returning { apply(ctx) }, and every side effect returns a disposer.', placeholder: 'may reference {{variables}}' },
    ],
    function (p) {
      const name = String(p.sectionName || 'foundry-rule')
      const order = parseInt(p.sectionOrder, 10)
      const n = order !== order ? 100 : order
      const text = String(p.sectionText || '')
      return {
        host: 'return {\n' +
          '  inject: ["systemPrompt"],\n' +
          '  apply(ctx) {\n' +
          '    return ctx.systemPrompt.section({\n' +
          '      name: ' + q(name) + ',\n' +
          '      order: ' + n + ',\n' +
          '      text: ' + q(text) + ',\n' +
          '    });\n' +
          '  },\n' +
          '}',
        client: null,
        notes: [
          'Injects an ordered section into the agent system prompt before every model step.',
          'apply returns the section disposer, so stop/update removes it automatically.',
          'Sections render in ascending order: -100 identity, 0 persona, 100-199 tool guidance.',
        ],
      }
    }
  ),
  makeBlueprint(
    'skill-registrar', 'Skill Registrar', 'host',
    'Registers a runtime Skill into the skills registry so the session catalog and loader can discover and load it.',
    "Use when a generated plugin should add a reusable, invocable capability (with a markdown body) to the agent's skill catalog.",
    [
      { name: 'skillName', label: 'Skill name (kebab-case)', type: 'string', required: true, default: 'foundry-handbook', placeholder: 'kebab-case' },
      { name: 'skillDescription', label: 'Short description', type: 'string', required: true, default: 'Foundry conventions for authoring dynamic Cordis plugins.', placeholder: 'routing description' },
      { name: 'skillWhenToUse', label: 'When to use', type: 'string', required: false, default: 'When authoring or editing a dynamic Cordis plugin.', placeholder: 'routing guidance' },
      { name: 'skillContent', label: 'Markdown body', type: 'string', required: true, default: 'A plugin body is a plain JS function returning { apply(ctx) }. Use only ctx.get/on/provide/effect, harness.registerTool, and injected services; return disposers from apply.', placeholder: 'markdown instruction body' },
    ],
    function (p) {
      const name = String(p.skillName || 'foundry-handbook')
      const desc = String(p.skillDescription || '')
      const when = String(p.skillWhenToUse || '')
      const content = String(p.skillContent || '')
      return {
        host: 'return {\n' +
          '  inject: ["skills"],\n' +
          '  apply(ctx) {\n' +
          '    return ctx.skills.register({\n' +
          '      name: ' + q(name) + ',\n' +
          '      description: ' + q(desc) + ',\n' +
          '      whenToUse: ' + q(when) + ',\n' +
          '      content: ' + q(content) + ',\n' +
          '      source: "runtime",\n' +
          '    });\n' +
          '  },\n' +
          '}',
        client: null,
        notes: [
          'Registers a runtime skill named ' + name + '; the catalog discovers it immediately.',
          'apply returns the disposer; same-name runtime entries are first-wins.',
        ],
      }
    }
  ),
  makeBlueprint(
    'fs-file-tool', 'Host FS File Tool', 'host',
    'Registers a model-callable Tool that reads, writes, and lists text files through the host fs service.',
    'Use when a generated plugin should give the agent file I/O over the host filesystem with a single tool.',
    [
      { name: 'toolName', label: 'Tool name', type: 'string', required: true, default: 'file-io', placeholder: 'snake_case tool name' },
      { name: 'toolDescription', label: 'Tool description', type: 'string', required: true, default: 'Read, write, or list text files. action: read|write|list; path: target path; content: body for write.', placeholder: 'what the tool does' },
    ],
    function (p) {
      const name = String(p.toolName || 'file-io')
      const desc = String(p.toolDescription || 'Read, write, or list text files.')
      return {
        host: 'return {\n' +
          '  inject: ["fs"],\n' +
          '  apply(ctx) {\n' +
          '    return harness.registerTool(ctx, harness.defineTool({\n' +
          '      name: ' + q(name) + ',\n' +
          '      description: ' + q(desc) + ',\n' +
          '      parameters: {\n' +
          '        type: "object",\n' +
          '        properties: {\n' +
          '          action: { type: "string", enum: ["read", "write", "list"] },\n' +
          '          path: { type: "string" },\n' +
          '          content: { type: "string" },\n' +
          '        },\n' +
          '        required: ["action", "path"],\n' +
          '      },\n' +
          '      output: {\n' +
          '        schema: { type: "json" },\n' +
          '        render: function (args, value) { return [{ type: "text", text: JSON.stringify(value) }]; },\n' +
          '      },\n' +
          '      execute: async function (args) {\n' +
          '        const target = await ctx.fs.resolve(args.path);\n' +
          '        if (args.action === "read") return { text: await ctx.fs.readText(target) };\n' +
          '        if (args.action === "list") {\n' +
          '          const entries = await ctx.fs.listDir(target);\n' +
          '          return entries.map(function (e) { return { name: e.name, type: e.type }; });\n' +
          '        }\n' +
          '        if (args.action === "write") {\n' +
          '          await ctx.fs.writeText(target, args.content || "");\n' +
          '          return { wrote: args.path };\n' +
          '        }\n' +
          '        return { error: "unknown action: " + args.action };\n' +
          '      },\n' +
          '    }));\n' +
          '  },\n' +
          '}',
        client: null,
        notes: [
          'Host-only plugin: registers a model-callable fs tool named ' + name + '.',
          'Always fs.resolve(path) first; listDir entries are mapped to scalar leaves.',
          'apply returns the registerTool disposer, so the tool is removed on stop/update.',
        ],
      }
    }
  ),
]

export function apply(ctx) {
  const blueprints = {}
  const subscribers = []

  function notify(bp) {
    const meta = serializeBlueprint(bp)
    subscribers.forEach(function (fn) { try { fn(meta) } catch (e) { /* noop */ } })
  }

  const foundry = {
    registerBlueprint(bp) {
      if (!bp || typeof bp.id !== 'string' || !bp.id || typeof bp.render !== 'function') return () => {}
      blueprints[bp.id] = bp
      notify(bp)
      return () => { if (blueprints[bp.id] === bp) delete blueprints[bp.id] }
    },
    listBlueprints() {
      return Object.keys(blueprints).map(function (k) { return serializeBlueprint(blueprints[k]) })
    },
    getBlueprint(id) { const b = blueprints[id]; return b ? serializeBlueprint(b) : undefined },
    scaffold(id, params) {
      const bp = blueprints[id]
      if (!bp) return { ok: false, error: 'Unknown blueprint: ' + id }
      try {
        const out = bp.render(params || {})
        return { ok: true, host: out.host || null, client: out.client || null, notes: out.notes || [] }
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) }
      }
    },
    validate(code) { return validateCode(code) },
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {}
      subscribers.push(fn)
      return () => { const i = subscribers.indexOf(fn); if (i >= 0) subscribers.splice(i, 1) }
    },
  }

  BUILTIN_BLUEPRINTS.forEach(function (bp) { blueprints[bp.id] = bp })

  // 发布 foundry Service —— 其它插件可 ctx.get('foundry')
  ctx.provide('foundry', foundry)

  ctx.tools.register(defineTool({
    name: 'foundry_blueprints',
    description: 'List every plugin blueprint in the Plugin Foundry (meta-plugin). Each blueprint is a recipe that scaffolds a new dynamic Cordis Plugin. Returns metadata: id, name, category, description, whenToUse, and the parameters each blueprint accepts.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_a, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async () => ({ blueprints: foundry.listBlueprints() }),
  }))

  ctx.tools.register(defineTool({
    name: 'foundry_scaffold',
    description: 'Scaffold a new dynamic Cordis Plugin from a Plugin Foundry blueprint. Returns ready-to-paste plain-JS code.host and code.client function bodies (no TypeScript/JSX), plus usage notes. Feed the result into cordis_define. List blueprints first with foundry_blueprints.',
    parameters: {
      blueprint: { type: 'string', required: true, description: 'Blueprint id (see foundry_blueprints).' },
      params: { type: 'json', description: 'Optional key/value overrides for blueprint parameters (e.g. { toolName: "hello" }).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_a, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args) => foundry.scaffold(args.blueprint, args.params || {}),
  }))

  ctx.tools.register(defineTool({
    name: 'foundry_validate',
    description: 'Statically lint a dynamic Cordis Plugin code body (host or client half) before cordis_define. Checks plain-JS-only rules (no import/require/TS/JSX), presence of a returned Plugin object with apply(ctx), and ctx.<service> usage without an inject declaration. Returns ok, errors, warnings, and a summary.',
    parameters: {
      code: { type: 'string', required: true, description: 'The plain-JS function body to lint.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_a, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args) => foundry.validate(args.code),
  }))

  // 供 Client 半设置页读取蓝图目录(只读)
  ctx.webServer.register({
    kind: 'exact',
    path: '/foundry/state',
    handler: async (_req, res) => {
      try {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ blueprints: foundry.listBlueprints() }))
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: String((e && e.message) || e) }))
      }
    },
  })
}
