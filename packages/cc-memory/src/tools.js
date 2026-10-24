// Model-facing memory tools.
//
// Read-only mode registers cc_memory_list / cc_memory_read. Read-write mode
// additionally registers cc_memory_write / cc_memory_edit. The names are
// namespaced (`cc_memory_*`) for the same reason cc-agents uses `cc_agent`:
// tools.register() throws on a duplicate name, so an unprefixed `memory_read`
// could make the whole plugin fail to load next to another memory plugin.
//
// The write half mirrors the two-step workflow the CLI teaches the model:
// write one topic file, then add a one-line pointer to MEMORY.md. Path handling
// is confined to the resolved memory directory; archive/, hidden segments and
// `..` are rejected in discovery.memoryPath().

import { editMemory, listMemories, readMemory, writeMemory } from './discovery.js'

/** Resolve the memory directory for the agent that called a tool. */
function memoryDirFor(exec, resolver, runtime) {
  if (runtime !== undefined && runtime.enabled === false) {
    throw new Error('auto-memory is disabled for this DSH session')
  }
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('memory tools require a calling agent with a session cwd')
  }
  return resolver.for(cwd)
}

function requireWritable(runtime) {
  if (runtime !== undefined && runtime.mode !== 'read-write') {
    throw new Error('auto-memory is read-only for this DSH session; switch it to read-write in /cc-memory')
  }
}

function sessionIdFor(exec) {
  const id = exec?.agent?.session?.header?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** One-line human summary per memory. */
function formatMemoryList(value) {
  if (value.memories.length === 0) {
    return `No memories saved yet in ${value.memory_dir}.`
  }
  const lines = value.memories.map((memory) => {
    const type = memory.type === null ? 'untyped' : memory.type
    const description = memory.description === null ? '(no description)' : memory.description
    return `- ${memory.name} — ${description} [${type}, ${new Date(memory.modified_ms).toISOString()}]`
  })
  return `Memories in ${value.memory_dir} (${value.memories.length}):\n${lines.join('\n')}`
}

const MEMORY_ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'description', 'type', 'modified_ms'],
  properties: {
    name: { type: 'string', description: 'Path relative to the memory directory.' },
    description: {
      oneOf: [
        { type: 'string' },
        { type: 'null' },
      ],
      description: 'Frontmatter description, or the first heading when absent.',
    },
    type: {
      oneOf: [
        { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] },
        { type: 'null' },
      ],
    },
    modified_ms: { type: 'number' },
  },
}

const LIST_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['memory_dir', 'memories'],
  properties: {
    memory_dir: { type: 'string' },
    memories: { type: 'array', items: MEMORY_ENTRY_SCHEMA },
  },
}

const READ_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'content', 'truncated'],
  properties: {
    name: { type: 'string' },
    content: { type: 'string' },
    truncated: { type: 'boolean' },
  },
}

const WRITE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'operation'],
  properties: {
    name: { type: 'string' },
    operation: { type: 'string', enum: ['create', 'update'] },
  },
}

const EDIT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'replacements'],
  properties: {
    name: { type: 'string' },
    replacements: { type: 'integer' },
  },
}

/**
 * Register the read-only half of the memory tools.
 * @param {object} ctx - plugin context (`ctx.tools`).
 * @param {{ resolver: { for(cwd: string): string }, opts: object, runtime?: object }} tools
 * @returns {Array<() => void>} registration disposers, so a later failure can unwind.
 */
export function registerReadTools(ctx, { resolver, opts, runtime }) {
  const disposers = []
  disposers.push(ctx.tools.register({
    name: 'cc_memory_list',
    description: 'List the saved auto-memory files (name, description, type, last modified), newest first. MEMORY.md and archive/ are not listed.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: LIST_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: formatMemoryList(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const memoryDir = memoryDirFor(exec, resolver, runtime)
      return {
        memory_dir: memoryDir,
        memories: listMemories(memoryDir, opts).map((memory) => ({
          name: memory.name,
          description: memory.description,
          type: memory.type,
          modified_ms: memory.modified_ms,
        })),
      }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'cc_memory_read',
    description: 'Read one saved memory by its path relative to the memory directory (for example "some-memory.md" or "MEMORY.md"). Use cc_memory_list first when you do not know the name.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Memory path relative to the memory directory.' },
      },
    },
    output: {
      schema: READ_OUTPUT,
      render: (_args, value) => [{
        type: 'text',
        text: value.truncated
          ? `${value.content}\n\n> WARNING: this memory was truncated at the per-file read limit.`
          : value.content,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const memoryDir = memoryDirFor(exec, resolver, runtime)
      const memory = readMemory(memoryDir, args.name, opts)
      return { name: memory.name, content: memory.content, truncated: memory.truncated }
    },
  }))
  return disposers
}

/**
 * Register the write tools. Only called in read-write mode.
 * @param {object} ctx - plugin context (`ctx.tools`).
 * @param {{ resolver: { for(cwd: string): string }, opts: object, runtime?: object }} tools
 * @returns {Array<() => void>} registration disposers, so a later failure can unwind.
 */
export function registerWriteTools(ctx, { resolver, opts, runtime }) {
  const disposers = []
  disposers.push(ctx.tools.register({
    name: 'cc_memory_write',
    description: 'Create or replace one auto-memory file. The frontmatter is generated from the arguments; the body is the memory text. This does not update MEMORY.md — add the one-line pointer with cc_memory_edit.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'description', 'type', 'content'],
      properties: {
        name: {
          type: 'string',
          description: 'Short kebab-case slug (no .md, no directories), e.g. "ci-green-does-not-mean-smoke-ran".',
        },
        description: { type: 'string', description: 'One-line summary used in the frontmatter and the index.' },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description: 'Memory type, mirroring Claude Code: user, feedback, project, or reference.',
        },
        content: {
          type: 'string',
          description: 'Applicable, durable, legible markdown body. One topic per file; include the why.',
        },
        pinned: {
          type: 'boolean',
          description: 'Mark this memory pinned (applies to every future session). Use sparingly.',
        },
      },
    },
    output: {
      schema: WRITE_OUTPUT,
      render: (_args, value) => [{
        type: 'text',
        text: `${value.operation === 'create' ? 'Created' : 'Updated'} memory "${value.name}". `
          + 'Now add or update its one-line pointer in MEMORY.md with cc_memory_edit.',
      }],
    },
    async execute(args, exec) {
      requireWritable(runtime)
      const memoryDir = memoryDirFor(exec, resolver, runtime)
      const result = writeMemory(memoryDir, {
        name: args.name,
        description: args.description,
        type: args.type,
        content: args.content,
        pinned: args.pinned === true,
        ...(sessionIdFor(exec) === undefined ? {} : { originSessionId: sessionIdFor(exec) }),
      })
      return { name: result.name, operation: result.operation }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'cc_memory_edit',
    description: 'Replace text inside one memory file, or inside MEMORY.md. old_string must be unique unless replace_all is true. The memory frontmatter\'s modified timestamp is refreshed automatically.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'old_string', 'new_string'],
      properties: {
        name: {
          type: 'string',
          description: 'Memory path relative to the memory directory, or "MEMORY.md" for the index.',
        },
        old_string: { type: 'string', description: 'Exact text to replace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness.' },
      },
    },
    output: {
      schema: EDIT_OUTPUT,
      render: (_args, value) => [{
        type: 'text',
        text: `Edited "${value.name}" (${value.replacements} replacement${value.replacements === 1 ? '' : 's'}).`,
      }],
    },
    async execute(args, exec) {
      requireWritable(runtime)
      const memoryDir = memoryDirFor(exec, resolver, runtime)
      const result = editMemory(memoryDir, {
        name: args.name,
        oldString: args.old_string,
        newString: args.new_string,
        replaceAll: args.replace_all === true,
      }, opts)
      return { name: result.name, replacements: result.replacements }
    },
  }))
  return disposers
}
