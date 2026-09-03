import { readFileSync } from 'node:fs'
import type { Event } from './impact.js'

/**
 * Claude Code writes one JSON object per line: an assistant turn carrying
 * `tool_use` blocks, then a user turn carrying the matching `tool_result`.
 * Probity's own reader is internal to the package, so a Stop hook needs
 * this minimal equivalent: writes and commands, each with its output.
 */
export function readTranscript(path: string): Event[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }

  const events: Event[] = []
  const pending = new Map<string, Event>()

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue // a partially flushed last line is normal while a session runs
    }
    for (const block of contentBlocks(row)) {
      if (isToolUse(block)) {
        const event = toEvent(block)
        if (!event) continue
        events.push(event)
        if (typeof block.id === 'string') pending.set(block.id, event)
      } else if (isToolResult(block)) {
        const event = pending.get(block.tool_use_id)
        if (event && event.kind !== 'prompt') event.output = resultText(block.content)
      }
    }
  }
  return events
}

type ToolUse = { type: 'tool_use'; id?: unknown; name?: unknown; input?: unknown }
type ToolResult = { type: 'tool_result'; tool_use_id: string; content?: unknown }

function contentBlocks(row: unknown): unknown[] {
  if (typeof row !== 'object' || row === null) return []
  const message = (row as { message?: unknown }).message
  const content = typeof message === 'object' && message !== null ? (message as { content?: unknown }).content : undefined
  return Array.isArray(content) ? content : []
}

function isToolUse(block: unknown): block is ToolUse {
  return typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool_use'
}

function isToolResult(block: unknown): block is ToolResult {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'tool_result' &&
    typeof (block as { tool_use_id?: unknown }).tool_use_id === 'string'
  )
}

function toEvent(block: ToolUse): Event | undefined {
  const name = typeof block.name === 'string' ? block.name : ''
  const input = (typeof block.input === 'object' && block.input !== null ? block.input : {}) as Record<string, unknown>

  if (name === 'Bash') {
    const command = typeof input['command'] === 'string' ? input['command'] : ''
    return command ? { kind: 'command', command, output: '' } : undefined
  }
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') {
    const path = typeof input['file_path'] === 'string' ? input['file_path'] : ''
    return path ? { kind: 'write', path, content: writtenText(input), output: '' } : undefined
  }
  return { kind: 'other', tool: name, input: block.input, output: '' }
}

/** Only the text a write introduces; an Edit carries no full file content. */
function writtenText(input: Record<string, unknown>): string {
  if (typeof input['content'] === 'string') return input['content']
  if (typeof input['new_string'] === 'string') return input['new_string']
  if (typeof input['new_source'] === 'string') return input['new_source']
  const edits = input['edits']
  if (Array.isArray(edits)) {
    return edits
      .map((edit) =>
        typeof edit === 'object' && edit !== null && typeof (edit as { new_string?: unknown }).new_string === 'string'
          ? (edit as { new_string: string }).new_string
          : '',
      )
      .join('\n')
  }
  return ''
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : '',
    )
    .join('\n')
}
